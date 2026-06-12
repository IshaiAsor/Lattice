import pino from 'pino';
import type { Logger } from 'pino';

export type LogContext = {
  traceId?: string;
  userId?: number;
  userDeviceId?: number;
  userActionId?: number;
  ruleId?: number;
  pipelineRunId?: number;
  sessionId?: string;
  [key: string]: unknown;
};

/**
 * Create a root logger bound to a service name.
 * In dev, output is pretty-printed. In prod, raw JSON for Grafana Agent ingestion.
 * Evaluated at call time so dotenv values are respected.
 */
export function createLogger(service: string): Logger {
  const isDev = process.env.NODE_ENV !== 'production';
  return pino({
    base: { service },
    level: process.env.LOG_LEVEL ?? 'info',
    ...(isDev
      ? { transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } }
      : {}),
  });
}

/**
 * Attach per-request context to a child logger.
 * Call once per inbound message/request, pass the child everywhere in that scope.
 *
 * const log = rootLogger.child(logCtx({ traceId, userId }));
 */
export function logCtx(ctx: LogContext): LogContext {
  return ctx;
}

// Default logger — services that just want a quick logger without a name
export const logger = createLogger('lattice');
