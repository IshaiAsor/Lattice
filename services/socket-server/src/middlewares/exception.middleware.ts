import type { ErrorRequestHandler } from 'express';
import { createLogger } from '@lattice/logger';

const log = createLogger('socket-server');

export const exceptionMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err: message }, 'unhandled error');
  res.status(500).json({ error: message });
};
