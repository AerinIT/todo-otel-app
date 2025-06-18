import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { trace } from '@opentelemetry/api';
import start from '../tracer';

const { logger } = start('auth-middleware');
const tracer = trace.getTracer('auth-middleware');

interface JwtPayload {
  userId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const auth = async (req: Request, res: Response, next: NextFunction) => {
  const span = tracer.startSpan('auth.verify');
  
  try {
    console.log('Auth middleware - headers:', req.headers);
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      console.log('No token provided');
      span.setAttribute('auth.status', 'no_token');
      span.end();
      return res.status(401).json({ error: 'Authentication required' });
    }

    console.log('Verifying token...');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as JwtPayload;
    console.log('Token decoded:', { userId: decoded.userId });

    const user = await User.findById(decoded.userId);
    console.log('User found:', user ? 'yes' : 'no');

    if (!user) {
      console.log('User not found for ID:', decoded.userId);
      span.setAttribute('auth.status', 'user_not_found');
      span.end();
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = {
      _id: user._id.toString(),
      id: user._id.toString(),
      username: user.username
    };

    span.setAttribute('auth.status', 'success');
    span.setAttribute('userId', user._id.toString());
    span.end();
    next();
  } catch (error: any) {
    console.error('Auth middleware error:', error);
    span.setAttribute('auth.status', 'error');
    span.setAttribute('error.type', error.name);
    span.recordException(error);
    span.end();

    logger.emit({
      severityText: 'ERROR',
      body: `Authentication error: ${error.message}`,
      attributes: {
        error: error.message,
        errorType: error.name
      }
    });

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }

    res.status(401).json({ error: 'Authentication failed' });
  }
}; 