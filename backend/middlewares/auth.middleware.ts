import { Request, Response, NextFunction } from 'express';
import { JwtPurpose, jwtService } from '../services/jwt.service';

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const verifyToken = (purpose: JwtPurpose) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.log(`Authorization header missing`);
      return res.sendStatus(401);
    }
    try {
      const token = authHeader.split(' ')[1];
      let decoded = jwtService.verifyToken(token, purpose);
      if (!decoded.valid) {
        return res.sendStatus(403);
      }
      req.user = decoded.decoded;
      next();
    } catch (err) {
      console.log(`Jwt validation failed ${err}`);
      return res.sendStatus(403);
    }
  };
};
