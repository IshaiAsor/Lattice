// jsonwebtoken reads `expiresIn: 0` as "expires now", not "never" — a 0 here silently mints
// dead tokens (that unlinked Google Home after every access-token expiry), so refuse to start.
function positiveSeconds(name: string, fallback: number): number {
  const value = +(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of seconds, got '${process.env[name]}'`);
  }
  return value;
}

const config = {
  port: +(process.env['PORT'] ?? 3010),
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  valkeyUrl: process.env['VALKEY_URL'] ?? 'redis://localhost:6379',
  jwt: {
    secret: process.env['JWT_SECRET'] ?? '',
    googleCloudToCloudLoginExpiresIn: positiveSeconds(
      'JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN',
      3600,
    ),
    // 180 days, sliding: every refresh issues a new refresh token, so an active link never lapses.
    googleCloudToCloudLoginRefreshExpiresIn: positiveSeconds(
      'JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH',
      15552000,
    ),
  },
  // Where account linking sends the user to sign in. Empty → same origin as this service, which
  // is what deployed environments want (the ingress serves the backoffice at / and this service
  // at /api/google on one host). Set it for local dev, where the UI runs on its own port.
  backofficeUrl: process.env['BACKOFFICE_URL'] ?? '',
  google: {
    authClientId: process.env['GOOGLE_AUTH_CLIENT_ID'] ?? '',
    authClientSecret: process.env['GOOGLE_AUTH_CLIENT_SECRET'] ?? '',
    serviceAccountKey: process.env['GOOGLE_SERVICE_ACCOUNT_KEY'],
  },
};

export default config;
