import express, { Request, Response } from 'express';
import { loginService } from '../services/login.service';
import { registerService } from '../services/register.service';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { authRateLimiter } from '../middlewares/rate.limiter.middleware';

const router = express.Router();
router.use(exceptionHandler);

router.post('/login', authRateLimiter, async (req: Request, res: Response) => {
  const { username, password } = req.body;
  let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ipAddress)) {
    ipAddress = ipAddress[0];
  }
  const authResult = await loginService.loginWithCredentials(username, password, ipAddress || 'unknown', JwtPurpose.app_usage);
  if (authResult) {
    return res.json(authResult.token);
  } else {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
});

router.post('/google', authRateLimiter, async (req, res) => {
  const { code, termsAccepted } = req.body;
  let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ipAddress)) {
    ipAddress = ipAddress[0];
  }
  try {
    var authResult = await loginService.loginWithGoogle(code, ipAddress || 'unknown', JwtPurpose.app_usage, termsAccepted === true);
    if (authResult) {
      return res.json(authResult.token);
    } else {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (err: any) {
    const status = err?.message?.includes('Terms of Service') ? 403 : 401;
    return res.status(status).json({ message: err?.message || 'Google login failed' });
  }
});

router.post('/register', authRateLimiter, async (req: Request, res: Response) => {
  const { username, email, password, termsAccepted } = req.body;
  try {
    const result = await registerService.register(username, email, password, termsAccepted === true);
    return res.status(201).json(result.token);
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    return res.status(status).json({ message: err?.message || 'Registration failed' });
  }
});

export default router;
