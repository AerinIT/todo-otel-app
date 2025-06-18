import mongoose from 'mongoose';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import start from '../tracer';

const { logger, meter } = start('database');
const tracer = trace.getTracer('mongodb-tracer');

// Create detailed MongoDB metrics
const mongoOperations = meter.createCounter('mongodb.operations', {
  description: 'Number of MongoDB operations',
  unit: 'operations'
});

const mongoOperationDuration = meter.createHistogram('mongodb.operation.duration', {
  description: 'Duration of MongoDB operations',
  unit: 'ms'
});

const mongoConnectionAttempts = meter.createCounter('mongodb.connection.attempts', {
  description: 'Number of MongoDB connection attempts',
  unit: 'attempts'
});

const mongoErrors = meter.createCounter('mongodb.errors', {
  description: 'Number of MongoDB errors'
});

// Additional MongoDB metrics
const mongoConnectionPoolSize = meter.createUpDownCounter('mongodb.pool.size', {
  description: 'MongoDB connection pool size',
  unit: 'connections'
});

const mongoActiveConnections = meter.createUpDownCounter('mongodb.connections.active', {
  description: 'Number of active MongoDB connections',
  unit: 'connections'
});

const mongoQueuedOperations = meter.createUpDownCounter('mongodb.operations.queued', {
  description: 'Number of queued MongoDB operations',
  unit: 'operations'
});

const mongoCollectionMetrics = meter.createHistogram('mongodb.collection.metrics', {
  description: 'MongoDB collection-level metrics',
  unit: 'ms'
});

// New performance metrics
const mongoQueryComplexity = meter.createHistogram('mongodb.query.complexity', {
  description: 'MongoDB query complexity score',
  unit: 'score'
});

const mongoIndexUsage = meter.createCounter('mongodb.index.usage', {
  description: 'MongoDB index usage statistics'
});

const mongoDocumentSize = meter.createHistogram('mongodb.document.size', {
  description: 'MongoDB document sizes',
  unit: 'bytes'
});

const mongoBatchOperations = meter.createHistogram('mongodb.batch.operations', {
  description: 'MongoDB batch operation sizes',
  unit: 'operations'
});

// Monitor MongoDB operations with enhanced tracing
mongoose.connection.on('query', (query) => {
  const startTime = Date.now();
  const span = tracer.startSpan('mongodb.query');
  
  // Calculate query complexity
  const queryComplexity = calculateQueryComplexity(query);
  
  span.setAttributes({
    'db.system': 'mongodb',
    'db.operation': query.operation,
    'db.collection': query.collection,
    'db.query': JSON.stringify(query.query || {}),
    'db.namespace': `${query.db}.${query.collection}`,
    'db.query.complexity': queryComplexity,
    'db.query.options': JSON.stringify(query.options || {}),
    'db.statement': query.operation === 'find' ? 'FIND' : query.operation.toUpperCase()
  });
  
  mongoOperations.add(1, {
    operation: query.operation,
    collection: query.collection
  });

  mongoQueryComplexity.record(queryComplexity, {
    operation: query.operation,
    collection: query.collection
  });

  // Record operation duration and details when it completes
  query.once('complete', (result: any) => {
    const duration = Date.now() - startTime;
    
    // Record operation metrics
    mongoOperationDuration.record(duration, {
      operation: query.operation,
      collection: query.collection,
      status: 'success'
    });

    mongoCollectionMetrics.record(duration, {
      collection: query.collection,
      operation: query.operation,
      status: 'success'
    });

    // Record document size metrics
    if (result) {
      const docSize = calculateDocumentSize(result);
      mongoDocumentSize.record(docSize, {
        collection: query.collection,
        operation: query.operation
      });
    }

    // Record batch operation metrics if applicable
    if (Array.isArray(result)) {
      mongoBatchOperations.record(result.length, {
        collection: query.collection,
        operation: query.operation
      });
    }

    // Check and record index usage
    if (query.options?.explain?.executionStats) {
      const { executionStats } = query.options.explain;
      mongoIndexUsage.add(1, {
        collection: query.collection,
        index: executionStats.executionStages.inputStage?.indexName || 'no_index',
        used_index: executionStats.executionStages.inputStage?.stage === 'IXSCAN'
      });
    }

    logger.emit({
      severityText: 'DEBUG',
      body: `MongoDB operation completed: ${query.operation}`,
      attributes: {
        'db.operation': query.operation,
        'db.collection': query.collection,
        'db.duration_ms': duration,
        'db.status': 'success',
        'db.query.complexity': queryComplexity,
        'db.result.size': Array.isArray(result) ? result.length : 1
      }
    });

    span.setAttributes({
      'db.duration_ms': duration,
      'db.status': 'success',
      'db.result.count': Array.isArray(result) ? result.length : 1
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });

  // Enhanced error tracking
  query.once('error', (error: Error) => {
    const duration = Date.now() - startTime;
    const errorCode = (error as any).code || 'unknown';
    const errorName = error.name || 'UnknownError';
    
    mongoOperationDuration.record(duration, {
      operation: query.operation,
      collection: query.collection,
      status: 'error',
      error_type: errorName,
      error_code: errorCode
    });

    mongoErrors.add(1, {
      operation: query.operation,
      collection: query.collection,
      error_type: errorName,
      error_code: errorCode,
      error_message: error.message
    });

    logger.emit({
      severityText: 'ERROR',
      body: `MongoDB operation failed: ${query.operation}`,
      attributes: {
        'db.operation': query.operation,
        'db.collection': query.collection,
        'db.duration_ms': duration,
        'db.error': error.message,
        'db.error_type': errorName,
        'db.error_code': errorCode,
        'db.query.complexity': queryComplexity
      }
    });

    span.recordException(error);
    span.setAttributes({
      'db.duration_ms': duration,
      'db.status': 'error',
      'error.type': errorName,
      'error.code': errorCode,
      'error.message': error.message
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
  });
});

// Enhanced connection monitoring
mongoose.connection.on('connected', () => {
  const span = tracer.startSpan('mongodb.connect');
  const conn = mongoose.connection as any;
  
  const poolInfo = {
    size: conn?.client?.topology?.connections?.length || 0,
    active: conn?.client?.topology?.connections?.filter((c: any) => c.active).length || 0,
    available: conn?.client?.topology?.connections?.filter((c: any) => !c.active).length || 0
  };

  span.setAttributes({
    'db.connection.pool.size': poolInfo.size,
    'db.connection.pool.active': poolInfo.active,
    'db.connection.pool.available': poolInfo.available,
    'db.connection.status': 'connected'
  });

  logger.emit({
    severityText: 'INFO',
    body: 'Connected to MongoDB successfully',
    attributes: {
      'db.pool.size': poolInfo.size,
      'db.pool.active': poolInfo.active,
      'db.pool.available': poolInfo.available
    }
  });
  
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
});

mongoose.connection.on('disconnected', () => {
  const span = tracer.startSpan('mongodb.disconnect');
  const conn = mongoose.connection as any;
  
  span.setAttributes({
    'db.connection.status': 'disconnected',
    'db.last_error': conn?.lastError?.message || null
  });

  logger.emit({
    severityText: 'WARN',
    body: 'MongoDB disconnected',
    attributes: {
      'db.last_error': conn?.lastError?.message || null,
      'db.disconnect.reason': conn?.lastError?.name || 'unknown'
    }
  });
  
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
});

// Enhanced pool monitoring
setInterval(() => {
  const conn = mongoose.connection as any;
  if (conn?.client?.topology) {
    const poolSize = conn.client.topology.connections?.length || 0;
    const activeConnections = conn.client.topology.connections?.filter(
      (conn: any) => conn.active
    ).length || 0;
    const availableConnections = poolSize - activeConnections;
    const maxPoolSize = conn.client.options.maxPoolSize || 100;
    const waitQueueSize = conn.client.topology.waitQueueSize || 0;
    
    mongoConnectionPoolSize.add(poolSize - (mongoConnectionPoolSize as any).value || 0);
    mongoActiveConnections.add(activeConnections - (mongoActiveConnections as any).value || 0);
    mongoQueuedOperations.add(waitQueueSize);
    
    logger.emit({
      severityText: 'DEBUG',
      body: 'MongoDB connection pool metrics',
      attributes: {
        'db.pool.size': poolSize,
        'db.pool.active': activeConnections,
        'db.pool.available': availableConnections,
        'db.pool.max_size': maxPoolSize,
        'db.pool.utilization': poolSize > 0 ? activeConnections / poolSize : 0,
        'db.pool.wait_queue_size': waitQueueSize
      }
    });
  }
}, 5000);

// Helper function to calculate query complexity
function calculateQueryComplexity(query: any): number {
  let complexity = 1;
  
  if (!query.query) return complexity;
  
  // Add complexity for query operators
  const countOperators = (obj: any): number => {
    let count = 0;
    for (const key in obj) {
      if (key.startsWith('$')) count++;
      if (typeof obj[key] === 'object') count += countOperators(obj[key]);
    }
    return count;
  };
  
  complexity += countOperators(query.query);
  
  // Add complexity for sorting
  if (query.options?.sort) complexity += Object.keys(query.options.sort).length;
  
  // Add complexity for aggregation pipelines
  if (query.operation === 'aggregate' && Array.isArray(query.query)) {
    complexity += query.query.length * 2;
  }
  
  return complexity;
}

// Helper function to calculate document size
function calculateDocumentSize(doc: any): number {
  return Buffer.byteLength(JSON.stringify(doc));
}

export async function connectDB() {
  const span = tracer.startSpan('mongodb.connect');
  
  try {
    mongoose.set('strictQuery', false);
    
    const mongoURI = process.env.MONGODB_URI || 'mongodb://mongodb:27017/todo-app';
    
    mongoConnectionAttempts.add(1);
    
    span.setAttributes({
      'db.system': 'mongodb',
      'db.connection.uri': mongoURI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'), // Mask credentials
      'db.name': 'todo-app'
    });
    
    console.log('Attempting to connect to MongoDB at:', mongoURI);
    
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
    });

    console.log('Successfully connected to MongoDB');
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    
    logger.emit({
      severityText: 'INFO',
      body: 'MongoDB connection established successfully',
      attributes: {
        'db.name': 'todo-app',
        'db.connection.options': {
          maxPoolSize: 10,
          minPoolSize: 2,
          maxIdleTimeMS: 30000
        }
      }
    });
  } catch (error) {
    const err = error as Error;
    
    console.error('Failed to connect to MongoDB:', err.message);
    
    mongoErrors.add(1, {
      operation: 'connect',
      error_type: err.name,
      error_message: err.message
    });
    
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.end();
    
    logger.emit({
      severityText: 'ERROR',
      body: 'Failed to connect to MongoDB',
      attributes: {
        'error.type': err.name,
        'error.message': err.message
      }
    });
    
    throw error;
  }
} 