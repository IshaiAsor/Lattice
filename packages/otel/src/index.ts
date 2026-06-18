import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { metrics } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'http';

export { trace, context, SpanStatusCode, metrics } from '@opentelemetry/api';
export { pinoMixin } from './mixin';

let _sdk: NodeSDK | undefined;
let _prometheusExporter: PrometheusExporter | undefined;

export function initOTel(serviceName: string): {
  metricsHandler: (req: IncomingMessage, res: ServerResponse) => void;
} {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  _prometheusExporter = new PrometheusExporter({ preventServerStart: true });

  const meterProvider = new MeterProvider({
    readers: [_prometheusExporter],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  if (endpoint) {
    _sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    });
    _sdk.start();
  }

  process.on('SIGTERM', async () => {
    await _sdk?.shutdown().catch(() => {});
    await meterProvider.shutdown().catch(() => {});
  });

  return {
    metricsHandler: (req, res) => _prometheusExporter!.getMetricsRequestHandler(req, res),
  };
}

export function getMeter(name: string) {
  return metrics.getMeter(name);
}
