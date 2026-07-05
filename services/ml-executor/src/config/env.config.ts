export const env = {
  port: parseInt(process.env['PORT'] ?? '3002', 10),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  ollamaUrl: (process.env['OLLAMA_URL'] ?? 'http://localhost:11434').replace(/\/$/, ''),
  onnxModelsDir: process.env['ONNX_MODELS_DIR'] ?? './models',
  // 4096 (Ollama's own default) is too small once a camera frame is embedded in the request —
  // a single image alone can run well past that in vision-token count. 32768 leaves headroom
  // for image + prompt + response on qwen2.5vl while still fitting comfortably in the model's
  // supported context window.
  llmNumCtx: parseInt(process.env['LLM_NUM_CTX'] ?? '32768', 10),
  // Node's default fetch (undici) headers timeout is 5 minutes, which a 7B vision model can
  // legitimately exceed once a real image + full context is in play — especially over the
  // cluster tunnel. Give it real headroom rather than failing requests that are still working.
  llmTimeoutMs: parseInt(process.env['LLM_TIMEOUT_MS'] ?? String(15 * 60 * 1000), 10),
  valkey: {
    url: process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    username: process.env['VALKEY_USER'] ?? process.env['REDIS_USER'],
    password: process.env['VALKEY_PASSWORD'] ?? process.env['REDIS_PASSWORD'],
  },
};
