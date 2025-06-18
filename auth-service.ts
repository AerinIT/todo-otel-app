import start from './tracer';
const { meter, logger } = start('auth-service');
import express from 'express';
import cors from 'cors';
import { connectDB } from './config/database';
import { User, IUser } from './models/User';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { trace, metrics } from '@opentelemetry/api';

console.log('Starting auth service...');

// Initialize tracer and logger
const tracer = trace.getTracer('auth-service');

// Create metrics
const authAttempts = meter.createCounter('auth.attempts', {
  description: 'Number of authentication attempts'
});

const authDuration = meter.createHistogram('auth.operation.duration', {
  description: 'Duration of authentication operations'
});

const activeUsers = meter.createUpDownCounter('auth.active_users', {
  description: 'Number of currently active users'
});

const registrationAttempts = meter.createCounter('auth.registration.attempts', {
  description: 'Number of registration attempts'
});

// Initialize express app
const app = express();

// CORS middleware must be first
app.use(cors({
  origin: ['http://localhost:8082', 'http://127.0.0.1:8082'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'traceparent', 'tracestate']
}));

// Other middleware
app.use(express.json());

// Debug middleware to log requests with trace context
app.use((req, res, next) => {
  const span = tracer.startSpan('http.request');
  const startTime = Date.now();
  
  // Add auth-specific attributes to differentiate from frontend traces
  span.setAttributes({
    'auth.service.version': '1.0.0',
    'auth.request.type': 'authentication',
    'auth.endpoint.category': req.path.split('/')[2] || 'root',
    'auth.request.timestamp': new Date().toISOString()
  });
  
  // Log request with trace context
  logger.emit({
    severityText: 'INFO',
    body: `Incoming ${req.method} request to ${req.path}`,
    attributes: {
      'http.method': req.method,
      'http.url': req.url,
      'http.target': req.path,
      'http.host': req.get('host'),
      'http.user_agent': req.get('user-agent')
    }
  });

  // Add response logging
  const oldSend = res.send;
  res.send = function(data: any) {
    const duration = Date.now() - startTime;
    
    // Record operation duration
    authDuration.record(duration, {
      operation: req.path,
      method: req.method,
      status: res.statusCode.toString()
    });

    // Log response with trace context
    logger.emit({
      severityText: res.statusCode >= 400 ? 'ERROR' : 'INFO',
      body: `Outgoing response for ${req.method} ${req.path}`,
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'http.status_code': res.statusCode,
        'http.duration_ms': duration
      }
    });

    span.setAttributes({
      'http.status_code': res.statusCode,
      'http.duration_ms': duration
    });
    span.end();

    return oldSend.call(res, data);
  };

  next();
});

// Connect to MongoDB with error handling
console.log('Attempting to connect to MongoDB...');
connectDB().catch((error: Error) => {
  const span = tracer.startSpan('mongodb.connection.error');
  logger.emit({
    severityText: 'ERROR',
    body: `MongoDB connection error: ${error.message}`,
    attributes: {
      error: error.message,
      error_name: error.name,
      stack: error.stack
    }
  });
  span.recordException(error);
  span.end();
  process.exit(1);
});

// Health check endpoint
app.get('/health', (req, res) => {
  const span = tracer.startSpan('auth.health');
  try {
    const mongoStatus = mongoose.connection.readyState === 1;
    const healthStatus = {
      status: mongoStatus ? 'healthy' : 'unhealthy',
      mongo: mongoStatus ? 'connected' : 'disconnected',
      uptime: process.uptime()
    };

    span.setAttributes({
      'health.status': healthStatus.status,
      'mongo.status': healthStatus.mongo
    });

    logger.emit({
      severityText: 'INFO',
      body: 'Health check performed',
      attributes: healthStatus
    });

    const statusCode = mongoStatus ? 200 : 503;
    res.status(statusCode).json(healthStatus);
  } catch (error: any) {
    span.recordException(error);
    logger.emit({
      severityText: 'ERROR',
      body: 'Health check failed',
      attributes: {
        error: error.message,
        stack: error.stack
      }
    });
    res.status(500).json({ 
      status: 'error', 
      error: error.message || 'Health check failed',
      uptime: process.uptime()
    });
  } finally {
    span.end();
  }
});

// Register endpoint
app.post('/auth/register', async (req, res) => {
  const span = tracer.startSpan('auth.register');
  registrationAttempts.add(1);
  
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      span.setAttribute('auth.register.status', 'invalid_input');
      logger.emit({
        severityText: 'WARN',
        body: 'Registration attempt with missing fields',
        attributes: {
          missing_fields: [
            !username && 'username',
            !email && 'email',
            !password && 'password'
          ].filter(Boolean)
        }
      });
      span.end();
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      span.setAttribute('auth.register.status', 'user_exists');
      logger.emit({
        severityText: 'WARN',
        body: 'Registration attempt with existing user',
        attributes: {
          attempted_username: username,
          attempted_email: email
        }
      });
      span.end();
      return res.status(400).json({ error: 'User already exists' });
    }

    // Create new user
    const user = await User.create({ username, email, password }) as IUser;
    activeUsers.add(1);

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    span.setAttribute('auth.register.status', 'success');
    span.setAttribute('userId', user._id.toString());

    logger.emit({
      severityText: 'INFO',
      body: 'New user registered successfully',
      attributes: {
        userId: user._id.toString(),
        username
      }
    });

    span.end();
    res.status(201).json({ token, user: { username: user.username, email: user.email } });
  } catch (error: any) {
    span.setAttribute('auth.register.status', 'error');
    span.recordException(error);
    
    logger.emit({
      severityText: 'ERROR',
      body: `Registration error: ${error.message}`,
      attributes: {
        error: error.message,
        error_name: error.name,
        stack: error.stack
      }
    });

    span.end();
    res.status(500).json({ error: 'Error registering user' });
  }
});

// Login endpoint
app.post('/auth/login', async (req, res) => {
  const span = tracer.startSpan('auth.login');
  authAttempts.add(1);
  
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      span.setAttribute('auth.login.status', 'invalid_input');
      span.end();
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Find user
    const user = await User.findOne({ username }) as IUser;
    if (!user) {
      span.setAttribute('auth.login.status', 'user_not_found');
      span.end();
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      span.setAttribute('auth.login.status', 'invalid_password');
      span.end();

      logger?.emit({
        severityText: 'WARN',
        body: 'Failed login attempt',
        attributes: {
          username,
          reason: 'invalid_password'
        }
      });

      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    span.setAttribute('auth.login.status', 'success');
    span.setAttribute('userId', user._id.toString());
    span.end();

    logger?.emit({
      severityText: 'INFO',
      body: 'User logged in successfully',
      attributes: {
        userId: user._id.toString(),
        username
      }
    });

    res.json({ token, user: { username: user.username, email: user.email } });
  } catch (error: any) {
    logger?.emit({
      severityText: 'ERROR',
      body: `Login error: ${error.message}`,
      attributes: {
        error: error.message
      }
    });

    span.setAttribute('auth.login.status', 'error');
    span.recordException(error);
    span.end();

    res.status(500).json({ error: error.message || 'Error logging in' });
  }
});

// Get user profile
app.get('/auth/profile', async (req, res) => {
  const span = tracer.startSpan('auth.profile');
  const token = req.header('Authorization')?.replace('Bearer ', '');

  try {
    if (!token) {
      span.setAttribute('auth.profile.status', 'no_token');
      span.end();
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as { userId: string };
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      span.setAttribute('auth.profile.status', 'user_not_found');
      span.end();
      return res.status(404).json({ error: 'User not found' });
    }

    span.setAttribute('auth.profile.status', 'success');
    span.setAttribute('userId', user._id.toString());
    span.end();

    res.json(user);
  } catch (error: any) {
    span.setAttribute('auth.profile.status', 'error');
    span.recordException(error);
    span.end();

    logger?.emit({
      severityText: 'ERROR',
      body: `Profile access error: ${error.message}`,
      attributes: {
        error: error.message
      }
    });

    res.status(401).json({ error: 'Invalid token' });
  }
});

// Error handling middleware must be last
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Global error handler:', err);
  
  // Create an error span
  const span = tracer.startSpan('error.handler');
  span.setAttributes({
    'error.type': err.name || 'UnknownError',
    'error.message': err.message || 'Unknown error occurred',
    'http.method': req.method,
    'http.url': req.url,
    'http.route': req.route?.path,
    'error.stack': err.stack || 'No stack trace available'
  });
  span.recordException(err);
  
  // Log with trace context (automatically included by our enhanced logger)
  logger?.emit({
    severityText: 'ERROR',
    body: `Unhandled error: ${err.message}`,
    attributes: {
      error: err.message,
      stack: err.stack,
      method: req.method,
      url: req.url,
      route: req.route?.path
    }
  });
  
  span.end();
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  logger?.emit({
    severityText: 'INFO',
    body: `Auth service listening on port ${PORT}`,
    attributes: {
      port: PORT
    }
  });
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger?.emit({
    severityText: 'INFO',
    body: 'SIGTERM received, shutting down gracefully'
  });

  server.close(() => {
    logger?.emit({
      severityText: 'INFO',
      body: 'HTTP server closed'
    });
  });

  try {
    // Disconnect MongoDB
    await mongoose.connection.close();
    logger?.emit({
      severityText: 'INFO',
      body: 'MongoDB connection closed'
    });

    process.exit(0);
  } catch (error: any) {
    logger?.emit({
      severityText: 'ERROR',
      body: `Error during graceful shutdown: ${error.message}`,
      attributes: {
        error: error.message
      }
    });
    process.exit(1);
  }
});