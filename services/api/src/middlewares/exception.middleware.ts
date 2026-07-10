import type { ErrorRequestHandler } from 'express';
import { createLogger } from '@lattice/logger';

const log = createLogger('api');

export const exceptionMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof (err as { statusCode?: unknown })?.statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
  if (status >= 500) log.error({ err: message }, 'unhandled error');
  else log.warn({ err: message, status }, 'request error');
  const body: Record<string, unknown> = { error: message };
  // Pass through a contextual email (e.g. the email_not_verified gate) so the UI can act on it.
  const email = (err as { email?: unknown })?.email;
  if (typeof email === 'string') body['email'] = email;
  res.status(status).json(body);
};
