export const env = {
  port:         parseInt(process.env['PORT'] ?? '3007', 10),
  jwtSecret:    process.env['JWT_SECRET'] ?? 'dev-secret',
  logLevel:     process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl:  process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  // Valkey connection — must be the SAME instance digest-service emits onto, so the
  // Socket.IO redis-adapter and digest's redis-emitter share the room pub/sub channel.
  valkey: {
    url:      process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    username: process.env['VALKEY_USER'] ?? process.env['REDIS_USER'],
    password: process.env['VALKEY_PASSWORD'] ?? process.env['REDIS_PASSWORD'],
  },
};
