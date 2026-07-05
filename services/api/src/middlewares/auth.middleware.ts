import type { RequestHandler } from 'express';
import { JwtPurpose } from '@lattice/jwt';
import { jwtService } from '../services/jwt.service';

export interface AppUser {
  id: number;
  role: string;
  email?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}

// Verifies an app_usage JWT and attaches { id, role, email } to req.user.
export const requireAppToken: RequestHandler = (req, res, next) => {
  const token =
    req.headers.authorization?.split(' ')[1] ?? (req.query['token'] as string | undefined);

  if (!token) {
    res.sendStatus(401);
    return;
  }

  const result = jwtService.verifyToken(token, JwtPurpose.app_usage);
  if (!result.valid) {
    res.sendStatus(403);
    return;
  }

  // The monolith signs `id`; tolerate `userId` too for forward-compat.
  const id = Number(result.decoded?.id ?? result.decoded?.userId);
  if (!id || isNaN(id)) {
    res.sendStatus(403);
    return;
  }

  req.user = { id, role: result.decoded?.role ?? 'user', email: result.decoded?.email };
  next();
};

// Must run after requireAppToken.
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return;
  }
  next();
};
