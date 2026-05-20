import { rateLimit } from 'express-rate-limit';
import config from '../config/env.config';

// Global rate limiter to protect all endpoints from general abuse/spam
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.limit, 
  standardHeaders: 'draft-8', // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false,       // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests from this IP, please try again later.' },
});

// Stricter rate limiter specifically for login/auth routes to prevent brute-force attacks
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // Max 10 login attempts per IP per window
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP, please try again after 15 minutes.' },
});
