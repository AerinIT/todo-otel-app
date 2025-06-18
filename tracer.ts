import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ParentBasedSampler } from '@opentelemetry/sdk-trace-base'
import { OurSampler } from './ourSampler';
import { W3CBaggagePropagator, W3CTraceContextPropagator, CompositePropagator } from '@opentelemetry/core'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { trace, context } from '@opentelemetry/api';

let loggerProvider: LoggerProvider;
let defaultLogger: any;
let sdk: NodeSDK;
let meterProvider: MeterProvider;
let isInitialized = false;

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

function getLoggerProvider(serviceName: string) {
    if (!loggerProvider) {
        // Create and configure the LoggerProvider with enhanced resource attributes
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

        // Create and configure the OTLP log exporter
        const logExporter = new OTLPLogExporter({
            url: 'http://alloy:4318/v1/logs',
            headers: {
                'Content-Type': 'application/x-protobuf'
            }
        });

        // Add the log processor to the provider
        loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));
    }

    return loggerProvider;
}

// Enhanced logger that automatically includes trace context
export function getLogger(serviceName: string = 'default-service') {
    if (!defaultLogger) {
        const provider = getLoggerProvider(serviceName);
        const baseLogger = provider.getLogger(`${serviceName}-logger`);
        
        // Create a wrapper that automatically includes trace context
        defaultLogger = {
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
    return defaultLogger;
}

function start(serviceName: string) {
    if (isInitialized) {
        const provider = getLoggerProvider(serviceName);
        return {
            meter: meterProvider.getMeter('my-service-meter'),
            logger: getLogger(serviceName)
        };
    }

    // Get or create logger provider with the service name
    const provider = getLoggerProvider(serviceName);
    const logger = getLogger(serviceName);

    const { endpoint, port } = PrometheusExporter.DEFAULT_OPTIONS;
    meterProvider = new MeterProvider({
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        }),
    }); 

    const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
            url: 'http://alloy:4318/v1/metrics'
        })
    });

    meterProvider.addMetricReader(metricReader);
    const meter = meterProvider.getMeter('my-service-meter');

    const traceExporter = new OTLPTraceExporter({
        url: 'http://alloy:4318/v1/traces',
    });

    if (!sdk) {
        sdk = new NodeSDK({
            traceExporter,
            serviceName: serviceName,
            instrumentations: [getNodeAutoInstrumentations({
                "@opentelemetry/instrumentation-fs": {
                    enabled: false
                },
                "@opentelemetry/instrumentation-http": {
                    headersToSpanAttributes: {
                        client: {
                            requestHeaders: ['tracestate', 'traceparent', 'baggage']
                        },
                        server: {
                            requestHeaders: ['tracestate', 'traceparent', 'baggage']
                        }
                    }
                }
            })],
            autoDetectResources: true,
            resource: new Resource({
                'team.owner': 'core-team',
                'deployment': '4'
            }),
            sampler: new ParentBasedSampler({
                root: new OurSampler()
            }),
            textMapPropagator: new CompositePropagator({
                propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
            })
        });

        sdk.start();
        isInitialized = true;
    }

    return {
        meter,
        logger
    };
}

export default start;