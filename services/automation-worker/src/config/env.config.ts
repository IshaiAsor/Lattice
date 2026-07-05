export const env = {
  port: parseInt(process.env['PORT'] ?? '3008', 10),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
};
