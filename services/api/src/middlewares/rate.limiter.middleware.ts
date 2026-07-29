import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.config';

// Global limiter — protects all endpoints from general abuse.
export const globalRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  limit: env.rateLimit.limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again later.' },
});

// Stricter limiter for auth routes — brute-force protection. Configurable so the dev/test stacks
// can raise it (see env.config); the defaults are the strict production values.
export const authRateLimiter = rateLimit({
  windowMs: env.rateLimit.authWindowMs,
  limit: env.rateLimit.authLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP, please try again after 15 minutes.' },
});
