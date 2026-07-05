import { JwtService, JwtPurpose } from '@lattice/jwt';
import { env } from '../config/env.config';

export { JwtPurpose };

// The api service mints and verifies app tokens only (web UI sessions).
// Device/Google-cloud tokens are other services' concerns.
export const jwtService = new JwtService(env.jwtSecret, {
  [JwtPurpose.app_usage]: env.jwt.appUsageExpiresIn,
  [JwtPurpose.app_usage_refresh]: env.jwt.appUsageRefreshExpiresIn,
});
