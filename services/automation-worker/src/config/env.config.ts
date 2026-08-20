export const env = {
  port: parseInt(process.env['PORT'] ?? '3008', 10),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  // State reconciliation (F23): periodically ask devices what state they are actually in, because
  // a command action's stored state is only ever as true as the last ack the platform happened
  // to see.
  reconcile: {
    enabled: process.env['RECONCILE_ENABLED'] !== 'false',
    cron: process.env['RECONCILE_CRON'] ?? '0 */5 * * * *',
    // How stale a confirmation may get before the action is worth re-reading.
    windowMs: parseInt(process.env['RECONCILE_WINDOW_MS'] ?? '1800000', 10),
    // How recently a device must have been heard from to be worth asking at all. `online` alone
    // is not enough: nothing marks a device offline if it dies without delivering its LWT.
    livenessMs: parseInt(process.env['RECONCILE_LIVENESS_MS'] ?? '300000', 10),
    // Ceiling on reads per pass, and the gap between them. Together they keep a 20-action device
    // from being read 20× at once and bound the pass well inside its own interval.
    batchSize: parseInt(process.env['RECONCILE_BATCH_SIZE'] ?? '50', 10),
    spacingMs: parseInt(process.env['RECONCILE_SPACING_MS'] ?? '200', 10),
    // A command sitting unsettled longer than this is presumed lost: it is marked timed out and
    // its action re-read. Comfortably past digest's own ack budget so the two never race.
    settleWindowMs: parseInt(process.env['RECONCILE_SETTLE_WINDOW_MS'] ?? '120000', 10),
  },
  // Liveness reaper: mark a device offline once it has missed enough heartbeats. The LWT covers a
  // clean disconnect; this covers power loss, where no will is ever delivered.
  liveness: {
    cron: process.env['LIVENESS_REAP_CRON'] ?? '0 * * * * *',
    // Firmware heartbeats every 60s, so this is three missed beats before we call it.
    timeoutMs: parseInt(process.env['LIVENESS_TIMEOUT_MS'] ?? '195000', 10),
  },
};
