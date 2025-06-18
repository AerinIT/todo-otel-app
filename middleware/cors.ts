import cors from 'cors';
import { Request, Response, NextFunction } from 'express';

// Define allowed headers for tracing and standard operations
export const allowedHeaders = [
    'Content-Type',
    'Authorization',
    'traceparent',
    'tracestate',
    'baggage',
    'x-request-id',
    'x-real-ip',
    'x-forwarded-for'
];

// Define headers that should be exposed to the client
export const exposedHeaders = [
    'server-timing',
    'traceparent',
    'tracestate',
    'baggage'
];

// Create configurable CORS middleware
export function createCorsMiddleware(options = {}) {
    const defaultOrigins = [
        'http://localhost:8082',
        'http://127.0.0.1:8082',
        'http://frontend:80'
    ];

    const defaultOptions = {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : defaultOrigins,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders,
        exposedHeaders,
        credentials: true,
        maxAge: 86400 // 24 hours
    };

    const corsMiddleware = cors({
        ...defaultOptions,
        ...options
    });

    // Wrap the CORS middleware to add error handling and logging
    return (req: Request, res: Response, next: NextFunction) => {
        corsMiddleware(req, res, (err) => {
            if (err) {
                console.error('CORS violation:', {
                    error: err.message,
                    origin: req.headers.origin,
                    method: req.method,
                    path: req.path,
                    headers: req.headers
                });
                return res.status(403).json({
                    error: 'CORS policy violation',
                    details: process.env.NODE_ENV === 'development' ? err.message : undefined
                });
            }
            next();
        });
    };
}

// OPTIONS preflight handler with enhanced headers
export function optionsHandler(req: Request, res: Response) {
    const origins = process.env.CORS_ORIGIN ? 
        process.env.CORS_ORIGIN.split(',') : 
        ['http://localhost:8082', 'http://127.0.0.1:8082', 'http://frontend:80'];

    const requestOrigin = req.headers.origin;
    const origin = requestOrigin && origins.includes(requestOrigin) ? requestOrigin : origins[0];

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(','));
    res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(','));
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).send();
} 