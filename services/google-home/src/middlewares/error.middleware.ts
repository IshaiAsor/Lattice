import { Request, Response, NextFunction } from 'express';
import { createLogger } from '@lattice/logger';

const log = createLogger('google-home');

// The 4-arg signature is what marks this as Express error middleware — keep _next.
export function errorMiddleware(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = err.status ?? 500;
  log.error({ method: req.method, url: req.url, status, err: err.message ?? err }, 'request error');
  res.status(status).json({ error: err.message ?? 'Internal server error' });
}
