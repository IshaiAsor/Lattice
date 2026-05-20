import express, { Request, Response } from 'express';
import { loginService } from '../services/login.service';
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
  const { code } = req.body;
  let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ipAddress)) {
    ipAddress = ipAddress[0];
  }
  var authResult = await loginService.loginWithGoogle(code, ipAddress || 'unknown', JwtPurpose.app_usage);
  if (authResult) {
    return res.json(authResult.token);
  } else {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
});

export default router;
