import { Request, Response, NextFunction } from 'express';
import { JwtService, JwtPurpose } from '@lattice/jwt';
import { createLogger } from '@lattice/logger';
import config from '../config/env.config';

const log = createLogger('google-home:auth-middleware');

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

const jwtService = new JwtService(config.jwt.secret, {
  [JwtPurpose.google_cloud_to_cloud_login]: config.jwt.googleCloudToCloudLoginExpiresIn,
  [JwtPurpose.google_cloud_to_cloud_login_refresh]:
    config.jwt.googleCloudToCloudLoginRefreshExpiresIn,
});

function extractToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader) return authHeader.split(' ')[1];

  if (req.body) {
    let bodyData = req.body;
    if (typeof bodyData === 'string') {
      bodyData = bodyData.trim();
      try {
        const parsed = JSON.parse(bodyData);
        if (parsed && typeof parsed === 'object') bodyData = parsed;
      } catch {}
    }
    if (typeof bodyData === 'string' && (bodyData.startsWith('ey') || bodyData.startsWith('"ey'))) {
      let t = bodyData;
      if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
      return t;
    }
  }

  if (req.query?.['token']) return req.query['token'] as string;
  return '';
}

export const verifyToken = (purpose: JwtPurpose) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (!token) {
      log.warn({ url: req.url }, 'no token found');
      return res.sendStatus(401);
    }
    const result = jwtService.verifyToken(token, purpose);
    if (!result.valid) {
      log.warn({ purpose, err: result.err }, 'JWT not valid');
      return res.sendStatus(403);
    }
    req.user = result.decoded;
    return next();
  };
};
