import type { RequestHandler } from 'express';
import type { DeviceTokenPayload, JwtPurpose } from '@lattice/jwt';
import { jwtService } from '../services/jwt.service';

declare global {
  namespace Express {
    interface Request {
      device?: DeviceTokenPayload;
    }
  }
}

export const requireDeviceToken =
  (...purposes: JwtPurpose[]): RequestHandler =>
  (req, res, next) => {
    const token =
      req.headers.authorization?.split(' ')[1] ?? (req.query['token'] as string | undefined);

    if (!token) {
      res.sendStatus(401);
      return;
    }

    for (const purpose of purposes) {
      const result = jwtService.verifyToken(token, purpose);
      if (result.valid) {
        req.device = result.decoded as DeviceTokenPayload;
        next();
        return;
      }
    }

    res.sendStatus(403);
  };
