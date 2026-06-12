import express from 'express';
import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';
import config from '../config/env.config';
import { renderAuthPage } from '../views/auth.view';
import { loginWithCredentials, loginWithGoogle } from '../services/login.service';
import { jwtService, JwtPurpose } from '../services/jwt.service';
import { valkeyService } from '../services/valkey.service';

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit:    10,
  standardHeaders: 'draft-8',
  legacyHeaders:   false,
});

// GET /auth — render login page for Google account linking
router.get('/auth', (req, res) => {
  const { redirect_uri, state, client_id, response_type } = req.query as Record<string, string>;

  if (!client_id || !redirect_uri || !state || response_type !== 'code') {
    return res.status(400).send('Missing required parameters');
  }
  if (client_id !== config.google.authClientId) {
    return res.status(401).send('Unauthorized: invalid client_id');
  }
  if (!redirect_uri.startsWith('https://oauth-redirect.googleusercontent.com/')) {
    return res.status(400).send('Invalid redirect_uri');
  }

  res.send(renderAuthPage('/auth/login', { redirect_uri, state, client_id, response_type }));
});

// POST /auth/login — credential or Google Sign-In submission
router.post('/auth/login', authLimiter, async (req, res) => {
  const { username, password, googleCode, redirect_uri, state, client_id, response_type } = req.body;

  if (!redirect_uri?.startsWith('https://oauth-redirect.googleusercontent.com/')) {
    return res.status(400).send('Invalid redirect_uri');
  }

  let result: Awaited<ReturnType<typeof loginWithCredentials>> = null;
  try {
    if (googleCode) {
      result = await loginWithGoogle(googleCode);
    } else if (username && password) {
      result = await loginWithCredentials(username, password);
    }
  } catch {
    result = null;
  }

  if (!result) {
    return res.send(renderAuthPage('/auth/login', { redirect_uri, state, client_id, response_type }, 'Invalid credentials'));
  }

  const code = crypto.randomBytes(16).toString('hex');
  await valkeyService.setOAuthCode(code, { userId: result.user.id, redirectUri: redirect_uri });
  res.redirect(`${redirect_uri}?code=${code}&state=${state}`);
});

// POST /token — exchange authorization code or refresh token for access token
router.post('/token', async (req, res) => {
  const { grant_type, code, refresh_token, redirect_uri } = req.body;

  let clientId     = req.body.client_id     as string;
  let clientSecret = req.body.client_secret as string;

  // Google may send credentials via HTTP Basic Auth
  const auth = req.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    [clientId, clientSecret] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  }

  const expectedSecret = config.google.authClientSecret;
  let secretValid = false;
  if (clientSecret && expectedSecret && clientSecret.length === expectedSecret.length) {
    secretValid = crypto.timingSafeEqual(Buffer.from(clientSecret), Buffer.from(expectedSecret));
  }

  if (clientId !== config.google.authClientId || !secretValid) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  try {
    let userId: string;

    if (grant_type === 'authorization_code') {
      if (!code) return res.status(400).json({ error: 'invalid_request' });

      const cached = await valkeyService.getOAuthCode(code);
      if (!cached) return res.status(401).json({ error: 'invalid_grant' });
      if (redirect_uri && redirect_uri !== cached.redirectUri) {
        await valkeyService.deleteOAuthCode(code);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      userId = String(cached.userId);
      await valkeyService.deleteOAuthCode(code); // single-use

    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) return res.status(400).json({ error: 'invalid_request' });
      const result = jwtService.verifyToken(refresh_token, JwtPurpose.google_cloud_to_cloud_login_refresh);
      if (!result.valid) return res.status(401).json({ error: 'invalid_grant' });
      userId = result.decoded.id;

    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    res.json({
      token_type:    'Bearer',
      access_token:  jwtService.generateToken({ id: userId, user: 'google' }, JwtPurpose.google_cloud_to_cloud_login),
      refresh_token: jwtService.generateToken({ id: userId, user: 'google' }, JwtPurpose.google_cloud_to_cloud_login_refresh),
      expires_in:    config.jwt.googleCloudToCloudLoginExpiresIn,
    });
  } catch {
    res.status(401).json({ error: 'invalid_grant' });
  }
});

export default router;
