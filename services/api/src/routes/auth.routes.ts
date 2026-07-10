import { Router } from 'express';
import { loginService } from '../services/login.service';
import { registerService } from '../services/register.service';
import { authFlowsService } from '../services/auth-flows.service';
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

// Self-service registration with username/password. No JWT is issued — the account is created
// unverified and a confirmation email is sent (F15.8). 202 = accepted, pending verification.
authRouter.post('/register', authRateLimiter, async (req, res, next) => {
  try {
    const { username, email, password, termsAccepted } = req.body ?? {};
    await registerService.register(username, email, password, termsAccepted === true);
    res.status(202).json({ pendingVerification: true });
  } catch (err) {
    next(err);
  }
});

// Confirm an email address via the link token → verifies + logs the user in.
authRouter.get('/verify-email', async (req, res, next) => {
  try {
    const token = String(req.query['token'] ?? '');
    const result = await authFlowsService.verifyEmail(token);
    res.json({ token: result.token, refreshToken: result.refreshToken, user: result.user });
  } catch (err) {
    next(err);
  }
});

// Resend the verification email for a pending account.
authRouter.post('/resend-verification', authRateLimiter, async (req, res, next) => {
  try {
    await authFlowsService.resendVerification(req.body?.email);
    res.status(202).json({ sent: true });
  } catch (err) {
    next(err);
  }
});

// Request a password reset. Always 202 — never reveals whether the account exists.
authRouter.post('/forgot-password', authRateLimiter, async (req, res, next) => {
  try {
    await authFlowsService.forgotPassword(req.body?.email);
    res.status(202).json({ sent: true });
  } catch (err) {
    next(err);
  }
});

// Complete a password reset with the emailed token.
authRouter.post('/reset-password', authRateLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body ?? {};
    await authFlowsService.resetPassword(token, password);
    res.sendStatus(204);
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
