import { initializeFaro, getWebInstrumentations } from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';

// Initialize Faro with web instrumentations and tracing
export const faro = initializeFaro({
    url: 'http://localhost:12346/collect',
    app: {
        name: 'frontend',
        version: '1.0.0',
    },
    instrumentations: [
        ...getWebInstrumentations(),
        new TracingInstrumentation({
            instrumentationOptions: {
                propagateTraceHeaderCorsUrls: [/.*/],
            },
        }),
    ],
});

// Get OTel trace and context APIs
const { trace, context, propagation } = faro.api.getOTEL();

// Helper function to create fetch headers with trace context
export function createFetchHeaders(additionalHeaders = {}) {
    const currentSpan = trace.getActiveSpan();
    if (!currentSpan) {
        return additionalHeaders;
    }

    const headers = { ...additionalHeaders };
    const ctx = trace.setSpan(context.active(), currentSpan);
    propagation.inject(ctx, headers);
    
    return headers;
}

// Helper function to wrap async operations with tracing
export async function withTraceSpan(name, operation, attributes = {}) {
    const tracer = trace.getTracer('frontend');
    const span = tracer.startSpan(name);
    
    try {
        // Add initial attributes
        Object.entries(attributes).forEach(([key, value]) => {
            span.setAttribute(key, value);
        });

        const result = await operation();
        span.setAttribute('operation.status', 'success');
        return result;
    } catch (error) {
        span.setAttribute('operation.status', 'error');
        span.setAttribute('error.message', error.message);
        span.recordException(error);
        throw error;
    } finally {
        span.end();
    }
}

export { trace, context }; 