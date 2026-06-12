import * as jwt from 'jsonwebtoken';
import config from '../config/env.config';

// Must stay in sync with api's JwtPurpose enum values
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
  const j = config.jwt;
  switch (purpose) {
    case JwtPurpose.device_provisioning:   return j.deviceProvisioningExpiresIn;
    case JwtPurpose.device_usage:          return j.deviceExpiresIn;
    case JwtPurpose.device_temp_usage:     return j.deviceTempExpiresIn;
    case JwtPurpose.device_usage_refresh:  return j.deviceRefreshExpiresIn;
    default: throw new Error(`Unsupported JWT purpose for device-gateway: ${purpose}`);
  }
};

export type DeviceTokenPayload = {
  id: number;       // userId
  deviceId: number; // userDeviceId
  mac_id: string;
  purpose: JwtPurpose;
};

class JwtService {
  generate(payload: Omit<DeviceTokenPayload, 'purpose'>, purpose: JwtPurpose): string {
    return jwt.sign(
      { ...payload, purpose },
      config.jwtSecret,
      { expiresIn: expiryFor(purpose) },
    );
  }

  verify(token: string, purpose: JwtPurpose): { valid: boolean; decoded: DeviceTokenPayload | null; err?: string } {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as DeviceTokenPayload;
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
