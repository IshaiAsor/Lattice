import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { context, trace, SpanStatusCode, diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

let _sdk: NodeSDK | undefined;

/**
 * Call ONCE at the very top of each service's entrypoint (before any other imports).
 * Instruments HTTP, Express, pg, ioredis, amqplib automatically.
 */
export function startOtel(serviceName: string, serviceVersion = '1.0.0'): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // no collector configured — skip silently in local dev

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  _sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs':  { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  _sdk.start();

  process.on('SIGTERM', () => _sdk?.shutdown());
  process.on('SIGINT',  () => _sdk?.shutdown());
}

/**
 * Extract the current OTel trace ID (W3C hex, 32 chars).
 * Returns undefined when no active span exists.
 */
export function getTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const traceId = span.spanContext().traceId;
  return traceId !== '00000000000000000000000000000000' ? traceId : undefined;
}

/**
 * Inject the current trace ID into RabbitMQ message headers before publishing.
 */
export function injectTraceHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const traceId = getTraceId();
  if (traceId) headers['x-trace-id'] = traceId;
  return headers;
}

// Re-export OTel API primitives so services only need one import
export { context, trace, SpanStatusCode };
export type { Span } from '@opentelemetry/api';
