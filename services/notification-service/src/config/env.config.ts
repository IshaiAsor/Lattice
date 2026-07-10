// Build-time configuration. Every channel's provider config is optional — an adapter with no
// creds loads as a no-op/log adapter (see channels/), so the service runs in dev without SMTP,
// VAPID, or Twilio set. Only the queue + Valkey connections are structurally required.
export const env = {
  port: parseInt(process.env['PORT'] ?? '3011', 10),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  // NOTE: deep links (verify-email / reset-password) are built by the *api* from its own
  // APP_BASE_URL/ALLOWED_ORIGINS and arrive here inside the payload's `data`. This service
  // renders them verbatim and needs no base URL of its own.
  // Dedupe window per (userId, eventType) — a repeat inside this TTL is suppressed (F15.3).
  dedupeTtlSeconds: parseInt(process.env['NOTIFICATION_DEDUPE_TTL'] ?? '300', 10),

  // Valkey — MUST be the same instance socket-server's redis-adapter listens on, so the
  // in-app channel's redis-emitter reaches user_{userId} rooms (same pattern as digest).
  valkey: {
    url: process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    username: process.env['VALKEY_USER'] ?? process.env['REDIS_USER'],
    password: process.env['VALKEY_PASSWORD'] ?? process.env['REDIS_PASSWORD'],
  },

  // Email channel (nodemailer SMTP). Disabled unless `host` is set.
  smtp: {
    host: process.env['SMTP_HOST'],
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    user: process.env['SMTP_USER'],
    password: process.env['SMTP_PASSWORD'],
    from: process.env['SMTP_FROM'] ?? 'Lattice <no-reply@lattice.local>',
  },

  // Push channel (web-push / VAPID). Disabled unless both keys are set.
  push: {
    vapidPublicKey: process.env['VAPID_PUBLIC_KEY'],
    vapidPrivateKey: process.env['VAPID_PRIVATE_KEY'],
    vapidSubject: process.env['VAPID_SUBJECT'] ?? 'mailto:admin@lattice.local',
  },
};
