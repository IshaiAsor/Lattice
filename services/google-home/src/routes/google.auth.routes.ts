import crypto from 'crypto';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { JwtPurpose, JwtService } from '@lattice/jwt';
import { createLogger } from '@lattice/logger';
import config from '../config/env.config';
import { verifyToken } from '../middlewares/auth.middleware';
import { oauthService } from '../services/oauth.service';
import { valkeyService } from '../services/valkey.service';

const log = createLogger('google-home:auth-routes');
const router = express.Router();

const jwtService = new JwtService(config.jwt.secret, {
  [JwtPurpose.google_cloud_to_cloud_login]: config.jwt.googleCloudToCloudLoginExpiresIn,
  [JwtPurpose.google_cloud_to_cloud_login_refresh]:
    config.jwt.googleCloudToCloudLoginRefreshExpiresIn,
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
}) as unknown as express.RequestHandler;

// Account linking entry point (Google Home app → here). This service owns no login UI: it parks
// the OAuth params and hands the user to the backoffice login page, which finishes the flow by
// calling /auth/authorize with a normal app session token.
router.get('/auth', async (req: Request, res: Response) => {
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

  try {
    const requestId = await oauthService.createLinkRequest({
      redirectUri: redirect_uri,
      state,
      clientId: client_id,
    });
    // Hash routing: the backoffice reads google_link off the route's query params.
    return res.redirect(`${config.backofficeUrl}/#/login?google_link=${requestId}`);
  } catch (err) {
    log.error({ err }, 'failed to create link request');
    return res.status(500).send('Unable to start account linking');
  }
});

// Called by the backoffice once the user is signed in. The app_usage JWT is the proof of
// identity — credentials never reach this service.
router.post(
  '/auth/authorize',
  authRateLimiter,
  verifyToken(JwtPurpose.app_usage),
  async (req: Request, res: Response) => {
    const { requestId } = req.body as { requestId?: string };
    const userId = Number(req.user?.id);

    if (!requestId) return res.status(400).json({ error: 'invalid_request' });
    if (!Number.isFinite(userId)) return res.status(403).json({ error: 'invalid_token' });

    try {
      const redirectUrl = await oauthService.authorize(requestId, userId);
      if (!redirectUrl) return res.status(410).json({ error: 'link_request_expired' });
      return res.json({ redirectUrl });
    } catch (err) {
      log.error({ err }, 'authorize error');
      return res.status(500).json({ error: 'server_error' });
    }
  },
);

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

  const secretValid =
    clientSecret?.length === expectedSecret.length &&
    crypto.timingSafeEqual(Buffer.from(clientSecret), Buffer.from(expectedSecret));

  if (clientId !== expectedId || !secretValid) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  try {
    let userId: string;

    if (grant_type === 'authorization_code') {
      if (!code) return res.status(400).json({ error: 'invalid_request' });

      const cached = await valkeyService.get<{ userId: number; redirectUri: string }>(
        `oauth_code:${code}`,
      );
      if (!cached) return res.status(401).json({ error: 'invalid_grant' });

      if (redirect_uri && redirect_uri !== cached.redirectUri) {
        await valkeyService.del(`oauth_code:${code}`);
        return res
          .status(400)
          .json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }

      userId = cached.userId.toString();
      await valkeyService.del(`oauth_code:${code}`);
    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) return res.status(400).json({ error: 'invalid_request' });

      const result = jwtService.verifyToken(
        refresh_token,
        JwtPurpose.google_cloud_to_cloud_login_refresh,
      );
      if (!result.valid) return res.status(401).json({ error: 'invalid_grant' });
      userId = result.decoded.id;
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    const accessToken = jwtService.generateToken(
      { id: userId, user: 'google' },
      JwtPurpose.google_cloud_to_cloud_login,
    );
    const newRefreshToken = jwtService.generateToken(
      { id: userId, user: 'google' },
      JwtPurpose.google_cloud_to_cloud_login_refresh,
    );

    res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: config.jwt.googleCloudToCloudLoginExpiresIn,
    });
  } catch (err) {
    log.error({ err }, 'token error');
    res.status(401).json({ error: 'invalid_grant' });
  }
});

export default router;
