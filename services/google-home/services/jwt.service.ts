import * as jwt from 'jsonwebtoken';
import config from '../config/env.config';

export enum JwtPurpose {
  app_usage                          = 0,
  app_usage_refresh                  = 1,
  device_provisioning                = 2,
  device_usage                       = 3,
  device_temp_usage                  = 4,
  device_usage_refresh               = 5,
  google_cloud_to_cloud_login        = 6,
  google_cloud_to_cloud_login_refresh = 7,
}

const expiryFor = (purpose: JwtPurpose): number => {
  switch (purpose) {
    case JwtPurpose.app_usage:                          return config.jwt.appUsageExpiresIn;
    case JwtPurpose.app_usage_refresh:                  return config.jwt.appUsageRefreshExpiresIn;
    case JwtPurpose.google_cloud_to_cloud_login:        return config.jwt.googleCloudToCloudLoginExpiresIn;
    case JwtPurpose.google_cloud_to_cloud_login_refresh: return config.jwt.googleCloudToCloudLoginRefreshExpiresIn;
    default: throw new Error(`Unsupported JWT purpose: ${purpose}`);
  }
};

class JwtService {
  generateToken(payload: object, purpose: JwtPurpose): string {
    return jwt.sign({ ...payload, purpose }, config.jwtSecret, { expiresIn: expiryFor(purpose) });
  }

  verifyToken(token: string, purpose: JwtPurpose): { valid: boolean; decoded: any; err?: string } {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as any;
      if (decoded.purpose !== purpose) {
        return { valid: false, decoded: null, err: `Wrong token purpose: ${decoded.purpose}` };
      }
      return { valid: true, decoded };
    } catch (err) {
      return { valid: false, decoded: null, err: String(err) };
    }
  }
}

export const jwtService = new JwtService();
