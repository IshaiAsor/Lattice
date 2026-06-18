import type { RequestHandler } from 'express';
import { JwtPurpose } from '@lattice/jwt';
import { jwtService } from '../services/jwt.service';

declare global {
  namespace Express {
    interface Request {
      appUser?: { id: number };
    }
  }
}

export const requireAppToken: RequestHandler = (req, res, next) => {
  const token =
    req.headers.authorization?.split(' ')[1] ??
    (req.query['token'] as string | undefined);

  if (!token) {
    res.sendStatus(401);
    return;
  }

  const result = jwtService.verifyToken(token, JwtPurpose.app_usage);
  if (!result.valid) {
    res.sendStatus(403);
    return;
  }

  const userId = Number(result.decoded?.id ?? result.decoded?.userId);
  if (!userId || isNaN(userId)) {
    res.sendStatus(403);
    return;
  }

  req.appUser = { id: userId };
  next();
};
