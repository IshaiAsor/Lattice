import jwt from 'jsonwebtoken';

export const JwtPurpose = {
  app_usage: 'app_usage',
  app_usage_refresh: 'app_usage_refresh',
  device_provisioning: 'device_provisioning',
  device_usage: 'device_usage',
  device_temp_usage: 'device_temp_usage',
  device_usage_refresh: 'device_usage_refresh',
  google_cloud_to_cloud_login: 'google_cloud_to_cloud_login',
  google_cloud_to_cloud_login_refresh: 'google_cloud_to_cloud_login_refresh',
} as const;

export type JwtPurpose = (typeof JwtPurpose)[keyof typeof JwtPurpose];

export interface AppTokenPayload {
  userId: string;
  purpose: 'app_usage' | 'app_usage_refresh';
}

export interface DeviceTokenPayload {
  userId: string;
  deviceId?: string;
  purpose: 'device_usage' | 'device_usage_refresh' | 'device_temp_usage' | 'device_provisioning';
}

export interface GoogleTokenPayload {
  userId: string;
  purpose: 'google_cloud_to_cloud_login' | 'google_cloud_to_cloud_login_refresh';
}

export function signJwt(payload: object, secret: string, expiresIn: string | number): string {
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
}

export function verifyJwt<T extends { purpose: JwtPurpose }>(
  token: string,
  purpose: JwtPurpose,
  secret: string,
): { valid: true; decoded: T } | { valid: false; err: string } {
  try {
    const decoded = jwt.verify(token, secret) as T;
    if (decoded.purpose !== purpose) {
      return { valid: false, err: `expected purpose '${purpose}', got '${decoded.purpose}'` };
    }
    return { valid: true, decoded };
  } catch (err) {
    return { valid: false, err: err instanceof Error ? err.message : String(err) };
  }
}

export class JwtService {
  constructor(
    private readonly secret: string,
    private readonly expiry: Partial<Record<JwtPurpose, number>>,
  ) {}

  generateToken(payload: object, purpose: JwtPurpose): string {
    const expiresIn = this.expiry[purpose];
    if (expiresIn === undefined) throw new Error(`No expiry configured for purpose: ${purpose}`);
    return signJwt({ ...payload, purpose }, this.secret, expiresIn);
  }

  verifyToken(
    token: string,
    purpose: JwtPurpose,
  ): { valid: boolean; decoded: any; err?: string | null } {
    const result = verifyJwt<any>(token, purpose, this.secret);
    return result.valid
      ? { valid: true, decoded: result.decoded }
      : { valid: false, decoded: null, err: result.err };
  }
}
