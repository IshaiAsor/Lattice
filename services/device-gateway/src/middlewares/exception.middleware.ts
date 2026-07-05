import type { ErrorRequestHandler } from 'express';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway');

export const exceptionMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof (err as { statusCode?: unknown })?.statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
  if (status >= 500) log.error({ err: message }, 'unhandled error');
  else log.warn({ err: message, status }, 'request error');
  res.status(status).json({ error: message });
};
