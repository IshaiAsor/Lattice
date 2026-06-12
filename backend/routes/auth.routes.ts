import express from 'express';
import { loginService } from '../services/login.service';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { authRateLimiter } from '../middlewares/rate.limiter.middleware';

const router = express.Router();
router.use(exceptionHandler);

const getIp = (req: express.Request): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (Array.isArray(fwd)) return fwd[0];
  return (fwd ?? req.socket.remoteAddress ?? 'unknown') as string;
};

router.post('/login', authRateLimiter, async (req, res) => {
  const { username, password } = req.body;
  const result = await loginService.loginWithCredentials(username, password, getIp(req));
  if (result) return res.json(result.token);
  return res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/google', authRateLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const token = await loginService.loginWithGoogle(code, getIp(req));
  res.json(token);
});

export default router;
