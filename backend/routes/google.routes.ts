import express, { Request, Response } from 'express';
import config from '../config/env.config';
import { renderAuthPage } from '../views/auth.view';
import { loginService } from '../services/login.service';
import { JwtPurpose, jwtService } from '../services/jwt.service';
import crypto from 'crypto';
import { redisService } from '../services/redis.service';
import { authRateLimiter } from '../middlewares/rate.limiter.middleware';
const router = express.Router();

router.get('/auth', (req: Request, res: Response) => {
  console.log('Received auth request:', req.query);
  const { redirect_uri, state, client_id, response_type } = req.query as any;

  if (!client_id || !redirect_uri || !state || response_type !== 'code') {
    return res.status(400).send('Missing required parameters or invalid response_type');
  }

  if (client_id !== config.googleAuth.clientId) {
    return res.status(401).send('Unauthorized: Invalid client_id');
  }

  // Mitigate Open Redirect Vulnerability
  if (!redirect_uri.startsWith('https://oauth-redirect.googleusercontent.com/')) {
    return res.status(400).send('Invalid redirect_uri: Must be a Google OAuth redirect URL');
  }

  const html = renderAuthPage('/api/google/auth/login', {
    redirect_uri,
    state,
    client_id,
    response_type,
  });
  res.send(html);
});

router.post('/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  const { username, password, googleCode, redirect_uri, state, client_id, response_type } =
    req.body;

  // Mitigate Open Redirect / Code Interception Vulnerability in the POST handler
  if (!redirect_uri || !redirect_uri.startsWith('https://oauth-redirect.googleusercontent.com/')) {
    return res.status(400).send('Invalid redirect_uri: Must be a Google OAuth redirect URL');
  }

  let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ipAddress)) {
    ipAddress = ipAddress[0];
  }

  let authResponse;

  if (googleCode) {
    authResponse = await loginService.loginWithGoogle(
      googleCode,
      ipAddress || 'unknown',
      JwtPurpose.google_cloud_to_cloud_login,
    );
  } else if (username && password) {
    authResponse = await loginService.loginWithCredentials(
      username,
      password,
      ipAddress || 'unknown',
      JwtPurpose.google_cloud_to_cloud_login,
    );
  }

  if (authResponse && authResponse.user) {
    const authCode = crypto.randomBytes(16).toString('hex');
    const redisKey = `oauth_code:${authCode}`;
    
    // Store both the user ID AND the redirect_uri in Redis with a 10-minute expiration
    await redisService.setTempData(redisKey, { 
      userId: authResponse.user.id, 
      redirectUri: redirect_uri 
    }, 600);
    
    const redirectUrl = `${redirect_uri}?code=${authCode}&state=${state}`;
    res.redirect(redirectUrl);
  } else {
    // Failure! Re-render the form with an error message
    const html = renderAuthPage(
      '/api/google/auth/login',
      { redirect_uri, state, client_id, response_type },
      'Invalid credentials',
    );
    res.send(html);
  }
});

router.post('/token', async (req: Request, res: Response) => {
  console.log('Received token request:', req.body);
  const { grant_type, code, refresh_token, redirect_uri } = req.body;

  let clientId = req.body.client_id;
  let clientSecret = req.body.client_secret;

  // Google might send client credentials via HTTP Basic Auth instead of the request body
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
    [clientId, clientSecret] = auth.split(':');
  }

  const expectedClientId = config.googleAuth.clientId || '';
  const expectedClientSecret = config.googleAuth.clientSecret || '';

  // Mitigate timing attacks on the client secret
  let isClientSecretValid = false;
  if (clientSecret && expectedClientSecret && clientSecret.length === expectedClientSecret.length) {
    isClientSecretValid = crypto.timingSafeEqual(
      Buffer.from(clientSecret),
      Buffer.from(expectedClientSecret)
    );
  }

  // 1. Authenticate the Client (Google's servers)
  if (clientId !== expectedClientId || !isClientSecretValid) {
    console.error('Unauthorized token request: Invalid client_id or client_secret');
    return res.status(401).json({ error: 'invalid_client' });
  }

  try {
    let userId: string;

    if (grant_type === 'authorization_code') {
      if (!code) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code parameter' });
      }

      const redisKey = `oauth_code:${code}`;
      const cachedData = await redisService.getTempData<{ userId: number, redirectUri: string }>(redisKey);
      
      if (!cachedData) {
        return res.status(401).json({ error: 'invalid_grant' });
      }

      // OAuth 2.0 Security Requirement: Verify the redirect_uri matches the one used in the authorization request
      if (redirect_uri && redirect_uri !== cachedData.redirectUri) {
        await redisService.deleteTempData(redisKey); // Burn the code on mismatch
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }

      userId = cachedData.userId.toString();
      
      // Delete the code to prevent replay attacks
      await redisService.deleteTempData(redisKey);
    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token parameter' });
      }

      // Extract the user ID from the refresh token
      const verfificationResult = jwtService.verifyToken(
        refresh_token,
        JwtPurpose.google_cloud_to_cloud_login_refresh,
      );
      if (!verfificationResult.valid) {
        return res.status(401).json({ error: 'invalid_grant' });
      }
      userId = verfificationResult.decoded.id;
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    // Generate actual access and refresh tokens for Google Assistant
    const token = jwtService.generateToken(
      { id: userId, user: 'google' },
      JwtPurpose.google_cloud_to_cloud_login,
    );
    const newRefreshToken = jwtService.generateToken(
      { id: userId, user: 'google' },
      JwtPurpose.google_cloud_to_cloud_login_refresh,
    );

    res.json({
      token_type: 'Bearer',
      access_token: token,
      refresh_token: newRefreshToken,
      expires_in: config.Jwt.GoogleCloudToCloudLoginExpiresIn,
    });
  } catch (error) {
    console.error('Token validation failed:', error);
    res.status(401).json({ error: 'invalid_grant' });
  }
});

export default router;
