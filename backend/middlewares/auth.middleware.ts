import { Request, Response, NextFunction } from 'express';
import { JwtPurpose, jwtService } from '../services/jwt.service';
import { createLogger } from '@lattice/logger';

const log = createLogger('api:auth');

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const verifyToken = (purpose: JwtPurpose) => {
  return (req: Request, res: Response, next: NextFunction) => {
    let token = '';

    const authHeader = req.headers.authorization;
    if (authHeader) {
      token = authHeader.split(' ')[1];
    }

    if (!token && req.body) {
      let bodyData = req.body;
      if (typeof bodyData === 'string') {
        bodyData = bodyData.trim();
        try {
          const parsed = JSON.parse(bodyData);
          if (parsed && typeof parsed === 'object') bodyData = parsed;
        } catch {}
      }

      if (typeof bodyData === 'string' && (bodyData.startsWith('ey') || bodyData.startsWith('"ey'))) {
        token = bodyData;
        if (token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1);
      } else if (bodyData?.provisioningToken) {
        token = bodyData.provisioningToken.trim();
      }
    }

    if (!token && req.query?.token) {
      token = req.query.token as string;
    }

    if (!token) {
      log.warn({ purpose, url: req.url }, 'auth failed: no token');
      return res.sendStatus(401);
    }

    const decoded = jwtService.verifyToken(token, purpose);
    if (!decoded.valid) {
      log.warn({ purpose, url: req.url, err: decoded.err }, 'auth failed: invalid token');
      return res.sendStatus(403);
    }

    req.user = decoded.decoded;
    next();
  };
};
