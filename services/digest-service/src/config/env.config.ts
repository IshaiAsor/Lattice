export const env = {
  port:         parseInt(process.env['PORT'] ?? '3006', 10),
  logLevel:     process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl:  process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  // How long to wait for a device's ack before marking an in-flight command failed.
  actionAckTimeoutMs: parseInt(process.env['ACTION_ACK_TIMEOUT_MS'] ?? '10000', 10),
  // How long to wait for a device to respond to an on-demand picture capture request
  // before ml-router falls back to the last durably-stored frame.
  pictureAckTimeoutMs: parseInt(process.env['PICTURE_ACK_TIMEOUT_MS'] ?? '15000', 10),
  valkey: {
    url:      process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    username: process.env['VALKEY_USER'] ?? process.env['REDIS_USER'],
    password: process.env['VALKEY_PASSWORD'] ?? process.env['REDIS_PASSWORD'],
  },
};
