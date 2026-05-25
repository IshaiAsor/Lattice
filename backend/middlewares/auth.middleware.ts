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
    
    // 1. Try Authorization Header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      token = authHeader.split(' ')[1];
    }
    
    // 2. Try Request Body (Intelligent detection)
    if (!token && req.body) {
      let bodyData = req.body;
      if (typeof bodyData === 'string') {
        bodyData = bodyData.trim();
        try {
          const parsed = JSON.parse(bodyData);
          if (parsed && typeof parsed === 'object') bodyData = parsed;
        } catch (e) {}
      }

      if (typeof bodyData === 'string' && (bodyData.startsWith('ey') || bodyData.startsWith('"ey'))) {
        token = bodyData;
        if (token.startsWith('"') && token.endsWith('"')) {
            token = token.substring(1, token.length - 1);
        }
      } else if (bodyData && bodyData.provisioningToken) {
        token = bodyData.provisioningToken.trim();
      }
    }
    
    // 3. Try Query Parameter (last resort)
    if (!token && req.query && req.query.token) {
      token = req.query.token as string;
    }

    if (!token) {
      console.log(`[AUTH] ❌ Failure: No token found for purpose ${purpose}. URL: ${req.url}`);
      console.log(`[AUTH] DEBUG: Headers: ${JSON.stringify(req.headers)}`);
      console.log(`[AUTH] DEBUG: Body Type: ${typeof req.body}`);
      return res.sendStatus(401);
    }

    try {
      let decoded = jwtService.verifyToken(token, purpose);
      if (!decoded.valid) {
        console.log(`[AUTH] ❌ Failure: JWT verification failed for purpose ${purpose}`);
        return res.sendStatus(403);
      }
      req.user = decoded.decoded;
      next();
    } catch (err) {
      console.log(`[AUTH] ❌ Exception during JWT validation: ${err}`);
      return res.sendStatus(403);
    }
  };
};
