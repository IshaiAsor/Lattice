import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import { connect, consume, QUEUES } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { db } from './db/client';
import { valkey } from './cache/valkey';
import { telemetryConsumer } from './consumers/telemetry.consumer';
import { deviceStatusConsumer } from './consumers/device-status.consumer';
import { actionRequestedConsumer } from './consumers/action-requested.consumer';
import { otaIncomingConsumer } from './consumers/ota-incoming.consumer';
import { healthRouter } from './routes/health.routes';

initOTel('digest-service');
const log = createLogger('digest-service');

async function main() {
  await valkey.connect();
  log.info('Valkey connected');

  await db.$connect();
  log.info('PostgreSQL connected');

  const ch = await connect(env.rabbitmqUrl);
  log.info('RabbitMQ connected');

  await consume(ch, QUEUES.TELEMETRY_ARRIVED, telemetryConsumer(ch));
  await consume(ch, QUEUES.DEVICE_STATE_CHANGED, deviceStatusConsumer());
  await consume(ch, QUEUES.ACTION_REQUESTED, actionRequestedConsumer(ch));
  await consume(ch, QUEUES.OTA_INCOMING, otaIncomingConsumer(ch));
  log.info('consumers started (telemetry, device-status, action-requested, ota-incoming)');

  const app = express();
  app.use(healthRouter);
  app.listen(env.port, () => log.info({ port: env.port }, 'digest-service listening'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
