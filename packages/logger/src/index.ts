import pino from 'pino';
import pinoHttp from 'pino-http';
import { pinoMixin } from '@lattice/otel';

export type { Logger } from 'pino';

// Probe/scrape endpoints hit by k8s liveness checks and Prometheus every few seconds —
// excluded so they don't drown out real request logs in Loki.
const IGNORED_PATHS = new Set(['/health', '/metrics']);

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

// One line per request (method, path, status, duration), correlated via the same
// traceId/spanId mixin as the service's regular logger.
export function createHttpLogger(logger: pino.Logger) {
  return pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => IGNORED_PATHS.has((req.url ?? '').split('?')[0]),
    },
  });
}
