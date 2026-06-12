import { Request, Response, NextFunction } from 'express';
import { createLogger } from '@lattice/logger';

const log = createLogger('api:error');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';

  if (status >= 500) {
    log.error({ err, method: req.method, url: req.url }, 'Unhandled error');
  } else {
    log.warn({ err: message, method: req.method, url: req.url }, 'Request error');
  }

  res.status(status).json({ error: message });
};

// Thin pass-through for route-level try/catch style (kept for back-compat with older routes)
export const exceptionHandler = (_req: Request, _res: Response, next: NextFunction): void => {
  next();
};
