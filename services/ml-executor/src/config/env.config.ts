export const env = {
  port:          parseInt(process.env['PORT'] ?? '3002', 10),
  logLevel:      process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint:  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl:   process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  ollamaUrl:     (process.env['OLLAMA_URL'] ?? 'http://localhost:11434').replace(/\/$/, ''),
  onnxModelsDir: process.env['ONNX_MODELS_DIR'] ?? './models',
  valkey: {
    url:      process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    username: process.env['VALKEY_USER'] ?? process.env['REDIS_USER'],
    password: process.env['VALKEY_PASSWORD'] ?? process.env['REDIS_PASSWORD'],
  },
};
