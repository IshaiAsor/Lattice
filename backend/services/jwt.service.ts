import * as jwt from 'jsonwebtoken';
import config from '../config/env.config';

export enum JwtPurpose {
  app_usage,
  app_usage_refresh,
  device_provisioning,
  device_usage,
  device_temp_usage,
  device_usage_refresh,
  google_cloud_to_cloud_login,
  google_cloud_to_cloud_login_refresh,
}

const expiryFor = (purpose: JwtPurpose): number => {
  const j = config.jwt;
  switch (purpose) {
    case JwtPurpose.app_usage:                         return j.appUsageExpiresIn;
    case JwtPurpose.app_usage_refresh:                 return j.appUsageRefreshExpiresIn;
    case JwtPurpose.device_provisioning:               return j.deviceProvisioningExpiresIn;
    case JwtPurpose.device_usage:                      return j.deviceExpiresIn;
    case JwtPurpose.device_temp_usage:                 return j.deviceTempExpiresIn;
    case JwtPurpose.device_usage_refresh:              return j.deviceRefreshExpiresIn;
    case JwtPurpose.google_cloud_to_cloud_login:       return j.googleCloudToCloudLoginExpiresIn;
    case JwtPurpose.google_cloud_to_cloud_login_refresh: return j.googleCloudToCloudLoginRefreshExpiresIn;
    default: throw new Error('Invalid token purpose');
  }
};

class JwtService {
  generateToken(payload: object, purpose: JwtPurpose): string {
    return jwt.sign(
      { ...payload, purpose },
      config.jwtSecret,
      { expiresIn: expiryFor(purpose) },
    );
  }

  verifyToken(token: string, purpose: JwtPurpose): { valid: boolean; decoded: any; err?: string } {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as any;
      if (decoded.purpose !== purpose) {
        return { valid: false, decoded: null, err: `Invalid token purpose ${decoded.purpose}` };
      }
      return { valid: true, decoded };
    } catch (err) {
      return { valid: false, decoded: null, err: String(err) };
    }
  }
}

export const jwtService = new JwtService();
