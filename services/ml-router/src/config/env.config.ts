const port = parseInt(process.env['PORT'] ?? '3009', 10);
const logLevel = process.env['LOG_LEVEL'] ?? 'info';
const otelEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
// Needed for the (deferred) telemetry pipeline dispatch onto the existing RMQ ML stages.
const rabbitmqUrl = process.env['RABBITMQ_URL'] ?? 'amqp://localhost';
const valkeyConfig = {
  url:      process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  username: process.env['VALKEY_USER'] ?? process.env['REDIS_USER'],
  password: process.env['VALKEY_PASSWORD'] ?? process.env['REDIS_PASSWORD'],
};

export const env = { port, logLevel, otelEndpoint, rabbitmqUrl, valkeyConfig };
