import pino from 'pino';
import { pinoMixin } from '@lattice/otel';

export type { Logger } from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export function createLogger(
  service: string,
  options?: { extra?: Record<string, unknown>; mixin?: () => Record<string, unknown> },
) {
  return pino({
    name: service,
    level: process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
    base: options?.extra ? { service, ...options.extra } : { service },
    // Attaches traceId/spanId from the active OTel span so Loki log lines
    // can be correlated back to the matching Tempo trace in Grafana.
    mixin: options?.mixin ?? pinoMixin,
  });
}
