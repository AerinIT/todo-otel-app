import start from './tracer';
const { logger, meter } = start('todo-service');
import express, { Request, Response, NextFunction } from 'express';
import opentelemetry, { SpanStatusCode, context, propagation, trace, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Baggage, BaggageEntry } from '@opentelemetry/api';
import cors from 'cors';
import { connectDB } from './config/database';
import { Todo } from './models/Todo';
import { auth } from './middleware/auth';
import schedule from 'node-schedule';
import Redis from 'ioredis';
import mongoose from 'mongoose';

// Business metrics
const todoOperations = meter.createHistogram('todo.operations', {
  description: 'Todo operations with duration',
  unit: 'ms',
});

const todoPriorities = meter.createUpDownCounter('todo.priorities', {
  description: 'Number of todos by priority level'
});

const todoCompletionRate = meter.createHistogram('todo.completion_rate', {
  description: 'Time taken to complete todos',
  unit: 'ms'
});

const userActivityGauge = meter.createUpDownCounter('user.activity', {
  description: 'User activity metrics'
});

const reminderMetrics = meter.createHistogram('todo.reminders', {
  description: 'Reminder scheduling and execution metrics',
  unit: 'ms'
});

// Performance metrics
const apiLatency = meter.createHistogram('api.latency', {
  description: 'API endpoint latency',
  unit: 'ms'
});

const cacheHitRatio = meter.createUpDownCounter('cache.hit_ratio', {
  description: 'Redis cache hit ratio'
});

// Error metrics
const errorRate = meter.createCounter('error.rate', {
  description: 'Error occurrence rate by type'
});

// Extend Express Request type
declare module 'express-serve-static-core' {
  interface Request {
    baggageUser?: {
      id: string;
      name: string;
    };
    user?: {
      _id: string;
      id: string;
      username: string;
    };
  }
}

const app = express();
const tracer = opentelemetry.trace.getTracer('todo-service');

// Initialize Redis client with error handling
const redis = new Redis({
  host: 'redis',
  port: 6379,
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

redis.on('error', (error: Error) => {
  logger.emit({
    severityText: 'ERROR',
    body: `Redis connection error: ${error.message}`,
    attributes: {
      error: error.message
    }
  });
});

redis.on('connect', () => {
  logger.emit({
    severityText: 'INFO',
    body: 'Redis connected successfully',
  });
});

// CORS middleware must be first
app.use(cors({
  origin: ['http://localhost:8082', 'http://127.0.0.1:8082'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'traceparent', 'tracestate']
}));

// Other middleware
app.use(express.json());

// Middleware to extract user from baggage
app.use((_req: Request, _res: Response, next: NextFunction) => {
  const activeContext = context.active();
  const baggage = propagation.getBaggage(activeContext);
  if (baggage) {
    const userId = baggage.getEntry('user.id')?.value;
    const userName = baggage.getEntry('user.name')?.value;
    if (userId && userName) {
      _req.baggageUser = { id: userId, name: userName };
    }
  }
  next();
});

// Connect to MongoDB
connectDB().catch((error: Error) => {
  logger.emit({
    severityText: 'ERROR',
    body: `MongoDB connection error: ${error.message}`,
    attributes: {
      error: error.message
    }
  });
});

// Initialize scheduler for reminders
const reminderJobs = new Map();

function scheduleReminder(todoId: string, reminderDate: Date, userId: string) {
  if (reminderJobs.has(todoId)) {
    reminderJobs.get(todoId).cancel();
  }

  const job = schedule.scheduleJob(reminderDate, async () => {
    const span = tracer.startSpan('todo.reminder');
    try {
      const todo = await Todo.findById(todoId);
      if (todo) {
        logger.emit({
          severityText: 'INFO',
          body: `Reminder: Todo "${todo.name}" is due soon`,
          attributes: {
            todoId,
            userId,
            todoName: todo.name
          }
        });
      }
      span.end();
    } catch (error) {
      span.recordException(error as Error);
      span.end();
    }
  });

  reminderJobs.set(todoId, job);
}

// Enhanced context middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const currentContext = context.active();
  const baggage = propagation.createBaggage({
    'service.name': { value: 'todo-service' },
    'service.version': { value: process.env.npm_package_version || '1.0.0' },
    'deployment.environment': { value: process.env.NODE_ENV || 'development' }
  });

  // Extract trace context from headers
  const extractedContext = propagation.extract(currentContext, req.headers);
  const span = tracer.startSpan('http.request', undefined, extractedContext);
  
  // Add request-specific context
  const requestBaggage = propagation.createBaggage({
    'http.method': { value: req.method },
    'http.url': { value: req.url },
    'http.host': { value: req.headers.host || '' },
    'request.id': { value: req.headers['x-request-id']?.toString() || generateRequestId() },
    'user.agent': { value: req.headers['user-agent'] || '' }
  });

  // Merge baggages
  const mergedBaggage = mergeBaggages(baggage, requestBaggage);
  
  // Set the context with baggage
  const spanContext = trace.setSpan(
    propagation.setBaggage(currentContext, mergedBaggage),
    span
  );

  // Store span and context in request for later use
  (req as any).span = span;
  (req as any).traceContext = spanContext;

  // Add trace context to response headers
  const traceHeaders: Record<string, string> = {};
  propagation.inject(spanContext, traceHeaders);
  Object.entries(traceHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Execute the request in the context
  context.with(spanContext, () => {
    res.on('finish', () => {
      const duration = Date.now() - (req as any).startTime;
      
      span.setAttributes({
        'http.status_code': res.statusCode,
        'http.response_time_ms': duration,
        'http.route': req.route?.path || req.path,
        'http.request_id': (req as any).requestId
      });

      if (res.statusCode >= 400) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${res.statusCode} returned`
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
    });

    next();
  });
});

// Enhance auth middleware to propagate user context
const enhancedAuth = (req: Request, res: Response, next: NextFunction) => {
  auth(req, res, async (err?: any) => {
    if (err) return next(err);

    const currentContext = context.active();
    const currentSpan = trace.getSpan(currentContext);
    
    if (req.user && currentSpan) {
      // Add user context to baggage
      const userBaggage = propagation.createBaggage({
        'user.id': { value: req.user.id },
        'user.name': { value: req.user.username },
        'user.role': { value: (req.user as any).role || 'user' }
      });

      // Merge with existing baggage
      const existingBaggage = propagation.getBaggage(currentContext);
      const mergedBaggage = mergeBaggages(existingBaggage, userBaggage);

      // Set the enhanced context
      const enhancedContext = propagation.setBaggage(currentContext, mergedBaggage);
      
      // Add user attributes to current span
      currentSpan.setAttributes({
        'user.id': req.user.id,
        'user.name': req.user.username,
        'enduser.id': req.user.id,
        'enduser.role': (req.user as any).role || 'user'
      });

      // Continue with enhanced context
      return context.with(enhancedContext, () => next());
    }

    next();
  });
};

// Helper function to merge baggages
function mergeBaggages(baggage1?: Baggage, baggage2?: Baggage): Baggage {
  const merged = propagation.createBaggage();
  
  if (baggage1) {
    baggage1.getAllEntries().forEach(([key, entry]: [string, BaggageEntry]) => {
      merged.setEntry(key, entry);
    });
  }
  
  if (baggage2) {
    baggage2.getAllEntries().forEach(([key, entry]: [string, BaggageEntry]) => {
      merged.setEntry(key, entry);
    });
  }
  
  return merged;
}

// Helper function to generate request ID
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Add HTTP semantic conventions
const HTTP_METHOD_GET = 'GET';
const HTTP_ROUTE_TODOS = '/todos';

// Get all todos for authenticated user
app.get(HTTP_ROUTE_TODOS, enhancedAuth, async (req: Request, res: Response) => {
  const requestStartTime = Date.now();
  const parentContext = context.active();
  
  // Create the main request span
  const requestSpan = tracer.startSpan('http.request', {
    attributes: {
      'http.method': HTTP_METHOD_GET,
      'http.route': HTTP_ROUTE_TODOS,
      'http.target': req.url,
      'http.host': req.headers.host || '',
      'http.scheme': req.protocol,
      'http.user_agent': req.headers['user-agent'] || '',
      'http.request_id': req.headers['x-request-id'] || generateRequestId(),
      'http.client_ip': req.ip,
      'http.flavor': req.httpVersion,
      'net.transport': 'IP.TCP',
    }
  }, parentContext);

  // Create operation span as child of request span
  const operationContext = trace.setSpan(parentContext, requestSpan);
  const operationSpan = tracer.startSpan('todo.list', {
    attributes: {
      'operation.name': 'list_todos',
      'operation.type': 'read',
      'service.name': 'todo-service'
    }
  }, operationContext);

  try {
    const userId = req.user!.id;
    const baggage = propagation.getBaggage(parentContext);
    
    // Create detailed operation context
    const operationBaggage = propagation.createBaggage({
      'operation.name': { value: 'list_todos' },
      'operation.timestamp': { value: new Date().toISOString() },
      'operation.id': { value: generateRequestId() },
      'service.version': { value: process.env.npm_package_version || '1.0.0' },
      'service.environment': { value: process.env.NODE_ENV || 'development' }
    });

    const enhancedContext = propagation.setBaggage(
      trace.setSpan(operationContext, operationSpan),
      mergeBaggages(baggage, operationBaggage)
    );

    // Execute operation with enhanced context
    return await context.with(enhancedContext, async () => {
      const cacheKey = `todos:${userId}`;
      
      // Create cache operation span
      const cacheSpan = tracer.startSpan('cache.get_todos', {
        attributes: {
          'cache.operation': 'get',
          'cache.key': cacheKey
        }
      }, enhancedContext);

      let todos;
      let cacheHit = false;
      try {
        const cachedTodos = await redis.get(cacheKey);
        if (cachedTodos) {
          todos = JSON.parse(cachedTodos);
          cacheHit = true;
          cacheHitRatio.add(1, { operation: 'get_todos' });
          cacheSpan.setAttribute('cache.hit', true);
        }
      } catch (error) {
        cacheSpan.recordException(error as Error);
        cacheSpan.setStatus({ code: SpanStatusCode.ERROR });
      } finally {
        cacheSpan.end();
      }

      if (!cacheHit) {
        // Create database operation span
        const dbSpan = tracer.startSpan('db.fetch_todos', {
          attributes: {
            'db.operation': 'find',
            'db.system': 'mongodb',
            'db.name': 'todo-app',
            'db.collection': 'todos',
            'db.query': JSON.stringify({ userId })
          }
        }, enhancedContext);

        try {
          todos = await Todo.find({ userId }).sort({ createdAt: -1 });
          await redis.setex(cacheKey, 300, JSON.stringify(todos));
          cacheHitRatio.add(0, { operation: 'get_todos' });
          
          dbSpan.setAttributes({
            'db.result.count': todos.length,
            'db.operation.success': true,
            'db.execution_time': Date.now() - requestStartTime
          });
          dbSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          dbSpan.recordException(error as Error);
          dbSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          dbSpan.end();
        }
      }

      // Record business metrics with context
      const completedTodos = todos.filter((todo: any) => todo.completed);
      const priorityCount = todos.reduce((acc: any, todo: any) => {
        acc[todo.priority] = (acc[todo.priority] || 0) + 1;
        return acc;
      }, {});

      // Business metrics span
      const metricsSpan = tracer.startSpan('metrics.record', {
        attributes: {
          'metrics.type': 'business',
          'metrics.operation': 'todo_analysis'
        }
      }, enhancedContext);

      const completionRate = todos.length ? completedTodos.length / todos.length : 0;

      try {
        Object.entries(priorityCount).forEach(([priority, count]) => {
          todoPriorities.add(count as number, { priority });
        });
        
        todoOperations.record(Date.now() - requestStartTime, {
          operation: 'list',
          user_id: userId,
          cache_hit: cacheHit
        });

        operationSpan.setAttributes({
          'todo.count': todos.length,
          'todo.completed_count': completedTodos.length,
          'todo.completion_rate': completionRate,
          'todo.priority_distribution': JSON.stringify(priorityCount),
          'operation.cache_hit': cacheHit,
          'operation.duration_ms': Date.now() - requestStartTime
        });

        metricsSpan.setAttributes({
          'metrics.todo.total': todos.length,
          'metrics.todo.completed': completedTodos.length,
          'metrics.todo.completion_rate': completionRate
        });
      } finally {
        metricsSpan.end();
      }

      // Set final request span attributes
      requestSpan.setAttributes({
        'http.response_content_length': JSON.stringify(todos).length,
        'http.response_time_ms': Date.now() - requestStartTime,
        'operation.success': true
      });
      requestSpan.setStatus({ code: SpanStatusCode.OK });

      // End operation span
      operationSpan.end();
      // End request span
      requestSpan.end();

      return res.json({ 
        todos, 
        user: { 
          username: req.user!.username, 
          userId 
        },
        metadata: {
          cached: cacheHit,
          completionRate: completionRate,
          totalCount: todos.length,
          completedCount: completedTodos.length
        }
      });
    });
  } catch (error) {
    const err = error as Error;
    
    // Record error metrics
    errorRate.add(1, {
      operation: 'list_todos',
      error_type: err.name,
      error_message: err.message
    });
    
    // Record error in spans
    operationSpan.recordException(err);
    operationSpan.setStatus({ code: SpanStatusCode.ERROR });
    operationSpan.end();

    requestSpan.recordException(err);
    requestSpan.setAttributes({
      'error.type': err.name,
      'error.message': err.message,
      'http.response_time_ms': Date.now() - requestStartTime
    });
    requestSpan.setStatus({ code: SpanStatusCode.ERROR });
    requestSpan.end();
    
    return res.status(500).json({ 
      error: 'Error fetching todos',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Create new todo
app.post('/todos', enhancedAuth, async (req: Request, res: Response) => {
  const span = tracer.startSpan('todo.create');
  const startTime = Date.now();
  
  try {
    const { name, dueDate, reminderDate, priority, description } = req.body;
    const baggage = propagation.getBaggage(context.active());
    const userName = baggage?.getEntry('user.name')?.value;
    
    if (!name) {
      errorRate.add(1, {
        operation: 'create_todo',
        error_type: 'validation',
        error_message: 'missing_name'
      });
      
      span.setAttribute('error', 'missing_name');
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      
      return res.status(400).json({ error: 'Todo name is required' });
    }

    const todoData = {
      userId: req.user!._id,
      name,
      description,
      priority: priority || 'medium',
      ...(dueDate && { dueDate: new Date(dueDate) }),
      ...(reminderDate && { reminderDate: new Date(reminderDate) })
    };

    const todo = new Todo(todoData);
    await todo.save();

    // Invalidate cache
    await redis.del(`todos:${req.user!._id}`);

    if (reminderDate) {
      const reminderSpan = tracer.startSpan('schedule.reminder', {
        attributes: {
          'todo.id': todo._id.toString(),
          'reminder.date': reminderDate
        }
      });
      
      scheduleReminder(todo._id.toString(), new Date(reminderDate), req.user!._id.toString());
      
      reminderMetrics.record(new Date(reminderDate).getTime() - Date.now(), {
        todo_id: todo._id.toString(),
        user_id: req.user!._id.toString()
      });
      
      reminderSpan.end();
    }

    todoPriorities.add(1, { priority: todo.priority });
    userActivityGauge.add(1, {
      user_id: req.user!._id.toString(),
      operation: 'create_todo'
    });

    todoOperations.record(Date.now() - startTime, {
      operation: 'create',
      priority: todo.priority,
      has_reminder: !!reminderDate
    });

    span.setAttributes({
      'todo.id': todo._id.toString(),
      'user.id': req.user!._id.toString(),
      'user.name': userName || 'unknown',
      'todo.name': name,
      'todo.priority': priority || 'medium',
      'todo.has_reminder': !!reminderDate,
      'operation.duration_ms': Date.now() - startTime
    });

    span.end();
    return res.status(201).json(todo);
  } catch (error) {
    const err = error as Error;
    errorRate.add(1, {
      operation: 'create_todo',
      error_type: err.name,
      error_message: err.message
    });
    
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    
    return res.status(500).json({ error: 'Error creating todo' });
  }
});

// Update todo
app.put('/todos/:id', enhancedAuth, async (req, res) => {
  const span = tracer.startSpan('todo.update');
  
  try {
    const { name, completed, dueDate, reminderDate, priority, description } = req.body;
    
    const todo = await Todo.findOne({ _id: req.params.id, userId: req.user!._id });
    
    if (!todo) {
      span.setAttribute('todo.status', 'not_found');
      span.end();
      return res.status(404).json({ error: 'Todo not found' });
    }

    todo.name = name || todo.name;
    todo.completed = completed !== undefined ? completed : todo.completed;
    todo.dueDate = dueDate || todo.dueDate;
    todo.reminderDate = reminderDate || todo.reminderDate;
    todo.priority = priority || todo.priority;
    todo.description = description || todo.description;

    await todo.save();

    if (reminderDate) {
      scheduleReminder(todo._id.toString(), new Date(reminderDate), req.user!._id.toString());
    }

    span.setAttribute('todo.id', todo._id.toString());
    span.setAttribute('userId', req.user!._id.toString());
    span.end();

    return res.json(todo);
  } catch (error) {
    span.recordException(error as Error);
    span.end();
    return res.status(500).json({ error: 'Error updating todo' });
  }
});

// Delete todo
app.delete('/todos/:id', enhancedAuth, async (req, res) => {
  const span = tracer.startSpan('todo.delete');
  
  try {
    const todo = await Todo.findOneAndDelete({ _id: req.params.id, userId: req.user!._id });
    
    if (!todo) {
      span.setAttribute('todo.status', 'not_found');
      span.end();
      return res.status(404).json({ error: 'Todo not found' });
    }

    if (reminderJobs.has(req.params.id)) {
      reminderJobs.get(req.params.id).cancel();
      reminderJobs.delete(req.params.id);
    }

    span.setAttribute('todo.id', req.params.id);
    span.setAttribute('userId', req.user!._id.toString());
    span.end();

    return res.json({ message: 'Todo deleted successfully' });
  } catch (error) {
    span.recordException(error as Error);
    span.end();
    return res.status(500).json({ error: 'Error deleting todo' });
  }
});

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  mongo: 'connected' | 'disconnected';
  redis: 'connected' | 'disconnected';
  uptime: number;
  error?: string;
}

// Health check endpoint
app.get('/health', async (_req, res) => {
  const span = tracer.startSpan('health.check');
  
  try {
    // Check MongoDB connection
    const mongoStatus = mongoose.connection.readyState === 1;
    
    // Check Redis connection
    const redisStatus = redis.status === 'ready';

    const healthStatus: HealthStatus = {
      status: (mongoStatus && redisStatus) ? 'healthy' : 'unhealthy',
      mongo: mongoStatus ? 'connected' : 'disconnected',
      redis: redisStatus ? 'connected' : 'disconnected',
      uptime: process.uptime()
    };

    span.setAttributes({
      'health.status': healthStatus.status,
      'mongo.status': healthStatus.mongo,
      'redis.status': healthStatus.redis
    });

    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    return res.status(statusCode).json(healthStatus);
  } catch (error: any) {
    const healthStatus: HealthStatus = {
      status: 'unhealthy',
      mongo: 'disconnected',
      redis: 'disconnected',
      uptime: process.uptime(),
      error: error.message || 'Unknown error occurred'
    };

    span.recordException(error);
    return res.status(503).json(healthStatus);
  } finally {
    span.end();
  }
});

// Error handling middleware must be last
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Global error handler:', err);
  
  // Create an error span
  const span = tracer.startSpan('error.handler');
  span.setAttributes({
    'error.type': err.name || 'UnknownError',
    'error.message': err.message || 'Unknown error occurred',
    'error.stack': err.stack || 'No stack trace available'
  });
  span.recordException(err);
  
  // Log with trace context
  logger.emit({
    severityText: 'ERROR',
    body: `Unhandled error: ${err.message}`,
    attributes: {
      error: err.message,
      stack: err.stack
    }
  });
  
  span.end();
  return res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;  // Match docker-compose environment variable
const server = app.listen(PORT, () => {
    logger.emit({
        severityText: 'INFO',
        body: `Todo service is running on port ${PORT}!`,
        attributes: {
            port: PORT
        }
    });
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger.emit({
    severityText: 'INFO',
    body: 'SIGTERM received, shutting down gracefully'
  });

  // Cancel all scheduled jobs
  for (const [todoId, job] of reminderJobs.entries()) {
    job.cancel();
    reminderJobs.delete(todoId);
  }

  // Close server
  server.close(() => {
    logger.emit({
      severityText: 'INFO',
      body: 'HTTP server closed'
    });
  });

  try {
    // Disconnect Redis
    await redis.quit();
    logger.emit({
      severityText: 'INFO',
      body: 'Redis connection closed'
    });

    // Disconnect MongoDB
    await mongoose.connection.close();
    logger.emit({
      severityText: 'INFO',
      body: 'MongoDB connection closed'
    });

    process.exit(0);
  } catch (error: any) {
    logger.emit({
      severityText: 'ERROR',
      body: `Error during graceful shutdown: ${error.message}`,
      attributes: {
        error: error.message
      }
    });
    process.exit(1);
  }
});

async function init() {
    opentelemetry.trace.getTracer('init').startActiveSpan('Set default items', async (span) => {
        const traceId = span.spanContext().traceId;
        const spanId = span.spanContext().spanId;

        logger.emit({
            severityText: 'INFO',
            body: 'Initializing default todo items',
            attributes: {
                traceId,
                spanId
            }
        });

        await Promise.all([
            redis.set('todo:1', JSON.stringify({ name: 'Install OpenTelemetry SDK' })),
            redis.set('todo:2', JSON.stringify({ name: 'Deploy OpenTelemetry Collector' })),
            redis.set('todo:3', JSON.stringify({ name: 'Configure sampling rule' })),
            redis.set('todo:4', JSON.stringify({ name: 'You are OpenTelemetry master!' }))
        ]);

        logger.emit({
            severityText: 'INFO',
            body: 'Default todo items initialized',
            attributes: {
                traceId,
                spanId
            }
        });

        span.end();
    });
}

init();
