import crypto from 'crypto';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { JwtPurpose, JwtService } from '@lattice/jwt';
import config from '../config/env.config';
import { authService } from '../services/auth.service';
import { valkeyService } from '../services/valkey.service';
import { renderAuthPage } from '../views/auth.view';

const router = express.Router();

const jwtService = new JwtService(config.jwt.secret, {
  [JwtPurpose.google_cloud_to_cloud_login]: config.jwt.googleCloudToCloudLoginExpiresIn,
  [JwtPurpose.google_cloud_to_cloud_login_refresh]: config.jwt.googleCloudToCloudLoginRefreshExpiresIn,
});

const authRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }) as unknown as express.RequestHandler;

router.get('/auth', (req: Request, res: Response) => {
  const { redirect_uri, state, client_id, response_type } = req.query as Record<string, string>;

  if (!client_id || !redirect_uri || !state || response_type !== 'code') {
    return res.status(400).send('Missing required parameters or invalid response_type');
  }
  if (client_id !== config.google.authClientId) {
    return res.status(401).send('Unauthorized: Invalid client_id');
  }
  if (!redirect_uri.startsWith('https://oauth-redirect.googleusercontent.com/')) {
    return res.status(400).send('Invalid redirect_uri');
  }

  res.send(renderAuthPage('/api/google/auth/login', { redirect_uri, state, client_id, response_type }));
});

router.post('/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  const { username, password, googleCode, redirect_uri, state, client_id, response_type } = req.body;

  if (!redirect_uri || !redirect_uri.startsWith('https://oauth-redirect.googleusercontent.com/')) {
    return res.status(400).send('Invalid redirect_uri');
  }

  const ip = (Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for']) ?? req.socket.remoteAddress ?? 'unknown';

  try {
    let user: { id: number } | null = null;

    if (googleCode) {
      user = await authService.loginWithGoogle(googleCode);
    } else if (username && password) {
      user = await authService.validateUser(username, password);
    }

    if (user) {
      const authCode = crypto.randomBytes(16).toString('hex');
      await valkeyService.set(`oauth_code:${authCode}`, { userId: user.id, redirectUri: redirect_uri }, 600);
      return res.redirect(`${redirect_uri}?code=${authCode}&state=${state}`);
    }
  } catch (err) {
    console.error('[google-auth] login error:', err);
  }

  res.send(renderAuthPage('/api/google/auth/login', { redirect_uri, state, client_id, response_type }, 'Invalid credentials'));
});

router.post('/token', async (req: Request, res: Response) => {
  const { grant_type, code, refresh_token, redirect_uri } = req.body;

  let clientId = req.body.client_id;
  let clientSecret = req.body.client_secret;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
    [clientId, clientSecret] = decoded.split(':');
  }

  const expectedId = config.google.authClientId;
  const expectedSecret = config.google.authClientSecret ?? '';

  const secretValid = clientSecret?.length === expectedSecret.length &&
    crypto.timingSafeEqual(Buffer.from(clientSecret), Buffer.from(expectedSecret));

  if (clientId !== expectedId || !secretValid) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  try {
    let userId: string;

    if (grant_type === 'authorization_code') {
      if (!code) return res.status(400).json({ error: 'invalid_request' });

      const cached = await valkeyService.get<{ userId: number; redirectUri: string }>(`oauth_code:${code}`);
      if (!cached) return res.status(401).json({ error: 'invalid_grant' });

      if (redirect_uri && redirect_uri !== cached.redirectUri) {
        await valkeyService.del(`oauth_code:${code}`);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }

      userId = cached.userId.toString();
      await valkeyService.del(`oauth_code:${code}`);

    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) return res.status(400).json({ error: 'invalid_request' });

      const result = jwtService.verifyToken(refresh_token, JwtPurpose.google_cloud_to_cloud_login_refresh);
      if (!result.valid) return res.status(401).json({ error: 'invalid_grant' });
      userId = result.decoded.id;

    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    const accessToken = jwtService.generateToken({ id: userId, user: 'google' }, JwtPurpose.google_cloud_to_cloud_login);
    const newRefreshToken = jwtService.generateToken({ id: userId, user: 'google' }, JwtPurpose.google_cloud_to_cloud_login_refresh);

    res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: config.jwt.googleCloudToCloudLoginExpiresIn,
    });
  } catch (err) {
    console.error('[google-auth] token error:', err);
    res.status(401).json({ error: 'invalid_grant' });
  }
});

export default router;
