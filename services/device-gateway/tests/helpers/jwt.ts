import { jwtService, JwtPurpose } from '../../services/jwt.service';

export type TokenPayload = { id: number; deviceId: number; mac_id: string };

/** Generate a real JWT signed with the test secret (set in tests/setup.ts). */
export function makeToken(payload: TokenPayload, purpose: JwtPurpose): string {
  return jwtService.generate(payload, purpose);
}

/** Verify and decode a token — useful for asserting token contents in tests. */
export function decodeToken(token: string, purpose: JwtPurpose) {
  return jwtService.verify(token, purpose);
}

/** Convenience shorthands */
export const makeProvisioningToken   = (p: TokenPayload) => makeToken(p, JwtPurpose.device_provisioning);
export const makeDeviceUsageToken    = (p: TokenPayload) => makeToken(p, JwtPurpose.device_usage);
export const makeDeviceRefreshToken  = (p: TokenPayload) => makeToken(p, JwtPurpose.device_usage_refresh);
