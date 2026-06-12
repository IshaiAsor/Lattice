import { Request, Response, NextFunction } from 'express';
import { JwtPurpose, jwtService, DeviceTokenPayload } from '../services/jwt.service';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway:auth');

declare global {
  namespace Express {
    interface Request {
      device?: DeviceTokenPayload;
    }
  }
}

export const verifyDeviceToken = (purpose: JwtPurpose) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1] ?? (req.query.token as string | undefined);

    if (!token) {
      log.warn({ purpose, url: req.url }, 'device auth: no token');
      return res.sendStatus(401);
    }

    const result = jwtService.verify(token, purpose);
    if (!result.valid || !result.decoded) {
      log.warn({ purpose, url: req.url, err: result.err }, 'device auth: invalid token');
      return res.sendStatus(403);
    }

    req.device = result.decoded;
    next();
  };
};
