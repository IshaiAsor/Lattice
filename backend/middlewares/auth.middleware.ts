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
    let token = '';
    const authHeader = req.headers.authorization;
    
    if (authHeader) {
      token = authHeader.split(' ')[1];
    } else if (req.body && req.body.provisioningToken) {
      token = req.body.provisioningToken;
    }

    if (!token) {
      console.log(`Authorization token missing (header or body)`);
      return res.sendStatus(401);
    }

    try {
      let decoded = jwtService.verifyToken(token, purpose);
      if (!decoded.valid) {
        console.log(`Jwt verification failed for purpose ${purpose}`);
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
