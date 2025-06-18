// Global guard to prevent duplicate initialization
if ((global as any).__otel_initialized) {
    // Already initialized, skip
    return (global as any).__otel_singleton;
}
(global as any).__otel_initialized = true;

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ParentBasedSampler } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { OurSampler } from './ourSampler';
import { W3CBaggagePropagator, W3CTraceContextPropagator, CompositePropagator } from '@opentelemetry/core'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { trace, context, propagation, Meter } from '@opentelemetry/api';

interface Logger {
    emit: (logRecord: any) => void;
}

// Global state
let loggerProvider: LoggerProvider;
let defaultLogger: Logger | undefined;
let sdk: NodeSDK;
let meterProvider: MeterProvider;
let isInitialized = false;
let globalLogger: Logger | undefined;
let globalMeter: Meter | undefined;
let tracerProvider: NodeTracerProvider;

// Initialize OpenTelemetry only once
export function initializeOpenTelemetry(serviceName: string) {
    if (isInitialized) {
        return {
            meter: globalMeter!,
            logger: globalLogger!
        };
    }

    try {
        // 1. Set up the logger provider with enhanced context
        loggerProvider = new LoggerProvider({
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
                [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
                [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
                'team.owner': 'core-team',
                'deployment.id': process.env.DEPLOYMENT_ID || '1',
                'application.name': 'todo-app'
            })
        });

        // 2. Enhanced trace context propagation
        const propagator = new CompositePropagator({
            propagators: [
                new W3CTraceContextPropagator(),
                new W3CBaggagePropagator(),
            ]
        });
        propagation.setGlobalPropagator(propagator);

        // 3. Set up the tracer provider with enhanced sampling and context
        tracerProvider = new NodeTracerProvider({
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
                [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
                [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
                'team.owner': 'core-team',
                'deployment': '4'
            }),
            sampler: new ParentBasedSampler({
                root: new OurSampler()
            })
        });

        // 4. Register enhanced auto-instrumentations
        const instrumentations = [
            getNodeAutoInstrumentations({
                "@opentelemetry/instrumentation-fs": {
                    enabled: false
                },
                "@opentelemetry/instrumentation-http": {
                    headersToSpanAttributes: {
                        client: {
                            requestHeaders: ['tracestate', 'traceparent', 'baggage', 'x-request-id'],
                            responseHeaders: ['server-timing']
                        },
                        server: {
                            requestHeaders: ['tracestate', 'traceparent', 'baggage', 'x-request-id'],
                            responseHeaders: ['server-timing']
                        }
                    },
                    applyCustomAttributesOnSpan: (span, request, response) => {
                        // Add more context to spans
                        span.setAttribute('http.request.headers', JSON.stringify(request.headers));
                        span.setAttribute('http.route', request.url);
                        span.setAttribute('http.client_ip', request.socket.remoteAddress || '');
                        
                        if (response) {
                            span.setAttribute('http.response.headers', JSON.stringify(response.getHeaders()));
                            span.setAttribute('http.response.size', response.get('content-length') || 0);
                        }
                    }
                },
                "@opentelemetry/instrumentation-express": {
                    enabled: true,
                    requestHook: (span, request) => {
                        span.setAttribute('request.correlation_id', request.headers['x-request-id'] || '');
                        span.setAttribute('request.path', request.path);
                        span.setAttribute('request.query', JSON.stringify(request.query));
                    }
                }
            })
        ];

        // 5. Create and configure the SDK
        sdk = new NodeSDK({
            traceExporter: new OTLPTraceExporter({
                url: 'http://alloy:4318/v1/traces',
            }),
            metricReader: new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({
                    url: 'http://alloy:4318/v1/metrics'
                })
            }),
            instrumentations,
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
                [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
                [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
                'team.owner': 'core-team',
                'deployment': '4'
            })
        });

        // 6. Start the SDK and register providers
        tracerProvider.register();
        sdk.start();

        isInitialized = true;
        
        // 7. Set up graceful shutdown
        process.on('SIGTERM', () => {
            sdk.shutdown()
                .then(() => console.log('SDK shut down successfully'))
                .catch((error) => console.log('Error shutting down SDK', error))
                .finally(() => process.exit(0));
        });

        return {
            meter: globalMeter!,
            logger: globalLogger!
        };

    } catch (error) {
        console.error('Failed to initialize OpenTelemetry:', error);
        throw error;
    }
}

// Helper function to create a logger
function createLogger(serviceName: string): Logger {
    const baseLogger = loggerProvider.getLogger(`${serviceName}-logger`);
    
    return {
        emit: (logRecord: any) => {
            const traceContext = getTraceContext();
            const enhancedLogRecord = {
                ...logRecord,
                attributes: {
                    ...logRecord.attributes,
                    ...traceContext
                }
            };
            baseLogger.emit(enhancedLogRecord);
        }
    };
}

// Helper function to get current trace context
function getTraceContext() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    
    const spanContext = span.spanContext();
    return {
        'trace.id': spanContext.traceId,
        'span.id': spanContext.spanId,
        'trace.flags': spanContext.traceFlags.toString(16)
    };
}

// Main start function
export function start(serviceName: string) {
    try {
        return initializeOpenTelemetry(serviceName);
    } catch (error) {
        console.error('Error in start function:', error);
        throw error;
    }
} 