export const env = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  jwtSecret: process.env['JWT_SECRET'] ?? 'dev-secret',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],

  // Comma-separated origins allowed to make cross-origin requests from the browser UI.
  allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200')
    .split(',')
    .map((s) => s.trim()),

  // Public base URL of the backoffice, used to build verify-email / reset-password links in
  // emails. Defaults to the first allowed origin. The UI uses hash routing (links add '#').
  appBaseUrl: (
    process.env['APP_BASE_URL'] ??
    (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200').split(',')[0]
  ).trim(),

  // Google sign-in (auth-code flow) — the UI exchanges a one-time code; we redeem it
  // server-side for the user's profile. 'postmessage' redirect (popup flow).
  googleSignIn: {
    clientId: process.env['GOOGLE_SIGN_IN_CLIENT_ID'] ?? '',
    clientSecret: process.env['GOOGLE_SIGN_IN_CLIENT_SECRET'] ?? '',
  },

  jwt: {
    appUsageExpiresIn: parseInt(process.env['JWT_APP_USAGE_EXPIRES_IN'] ?? '86400', 10), // 1 day
    appUsageRefreshExpiresIn: parseInt(
      process.env['JWT_APP_USAGE_REFRESH_EXPIRES_IN'] ?? '2592000',
      10,
    ), // 30 days
  },

  rateLimit: {
    windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? String(15 * 60 * 1000), 10),
    limit: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] ?? '150', 10),
  },

  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
};
