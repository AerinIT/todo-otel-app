import { Request, Response, NextFunction } from 'express';
import { context, propagation, trace, Baggage } from '@opentelemetry/api';
import start from '../tracer';

// Extend the Request type to include user
declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: string;
      username: string;
      _id?: string;
    };
  }
}

const { logger } = start('baggage-middleware');
const tracer = trace.getTracer('baggage-middleware');

interface BaggageEntries {
  [key: string]: string;
}

// Helper function to extract all baggage entries
function extractBaggageEntries(baggage: Baggage | undefined): BaggageEntries {
  if (!baggage) return {};
  
  const entries = [
    'user.id',
    'user.name',
    'user.email',
    'user.role',
    'todo.id',
    'todo.name',
    'todo.priority',
    'todo.due_date',
    'todo.completed',
    'operation.name',
    'operation.timestamp'
  ];

  return entries.reduce<BaggageEntries>((acc, key) => {
    const value = baggage.getEntry(key)?.value;
    if (value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

// Debug middleware to log baggage content
export const debugBaggageMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const span = tracer.startSpan('baggage.debug');
  const baggage = propagation.getBaggage(context.active());
  const baggageEntries = extractBaggageEntries(baggage);
  
  logger.emit({
    severityText: 'DEBUG',
    body: `Baggage debug for ${req.method} ${req.path}`,
    attributes: {
      path: req.path,
      method: req.method,
      'baggage.exists': baggage !== undefined,
      ...baggageEntries
    }
  });

  span.setAttributes({
    'baggage.exists': baggage !== undefined,
    ...baggageEntries
  });
  
  span.end();
  next();
};

export const setBaggageMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if (req.user) {
    const baggage = propagation.createBaggage({
      'user.name': { value: req.user.username },
      'user.id': { value: req.user.id }
    });
    const contextWithBaggage = propagation.setBaggage(context.active(), baggage);
    context.with(contextWithBaggage, () => {
      next();
    });
  } else {
    next();
  }
}; 