import { Router } from 'express';
import { loginService } from '../services/login.service';
import { registerService } from '../services/register.service';
import { authRateLimiter } from '../middlewares/rate.limiter.middleware';

export const authRouter = Router();

function clientIp(req: {
  headers: Record<string, unknown>;
  socket: { remoteAddress?: string };
}): string {
  const fwd = req.headers['x-forwarded-for'];
  const ip = Array.isArray(fwd) ? fwd[0] : fwd;
  return (
    (typeof ip === 'string' ? ip.split(',')[0].trim() : undefined) ??
    req.socket.remoteAddress ??
    'unknown'
  );
}

// Username/password login. Returns { token, refreshToken }.
authRouter.post('/login', authRateLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    const result = await loginService.loginWithCredentials(username, password, clientIp(req));
    if (!result) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.json({ token: result.token, refreshToken: result.refreshToken });
  } catch (err) {
    next(err);
  }
});

// Google auth-code sign-in (popup flow). Creates the account on first sign-in.
authRouter.post('/google', authRateLimiter, async (req, res, next) => {
  try {
    const { code, termsAccepted } = req.body ?? {};
    const result = await loginService.loginWithGoogle(code, clientIp(req), termsAccepted === true);
    if (!result) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.json({ token: result.token, refreshToken: result.refreshToken });
  } catch (err) {
    next(err);
  }
});

// Self-service registration with username/password.
authRouter.post('/register', authRateLimiter, async (req, res, next) => {
  try {
    const { username, email, password, termsAccepted } = req.body ?? {};
    const result = await registerService.register(
      username,
      email,
      password,
      termsAccepted === true,
    );
    res.status(201).json({ token: result.token, refreshToken: result.refreshToken });
  } catch (err) {
    next(err);
  }
});

// Exchange a refresh token for a new access + refresh token pair (rotating refresh).
authRouter.post('/refresh-token', authRateLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) {
      res.status(401).json({ error: 'Refresh token required' });
      return;
    }
    const result = await loginService.refreshToken(refreshToken);
    if (!result) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }
    res.json({ token: result.token, refreshToken: result.refreshToken });
  } catch (err) {
    next(err);
  }
});
