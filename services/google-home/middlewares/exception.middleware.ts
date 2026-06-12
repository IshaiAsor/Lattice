import { Request, Response, NextFunction } from 'express';
import { createLogger } from '@lattice/logger';

const log = createLogger('google-home:error');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const status  = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  if (status >= 500) log.error({ err, url: req.url }, 'unhandled error');
  res.status(status).json({ error: message });
};
