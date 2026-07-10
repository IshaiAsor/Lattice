import { initOTel } from '@lattice/otel';
import { createLogger, createHttpLogger } from '@lattice/logger';
import { connect, consume, QUEUES } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { db } from './db/client';
import { valkey } from './cache/valkey';
import { telemetryConsumer } from './consumers/telemetry.consumer';
import { deviceStatusConsumer } from './consumers/device-status.consumer';
import { deviceHeartbeatConsumer } from './consumers/device-heartbeat.consumer';
import { actionRequestedConsumer } from './consumers/action-requested.consumer';
import { actionResultConsumer } from './consumers/action-result.consumer';
import { pictureRequestedConsumer } from './consumers/picture-requested.consumer';
import { otaIncomingConsumer } from './consumers/ota-incoming.consumer';
import { healthRouter } from './routes/health.routes';

const { metricsHandler } = initOTel('digest-service');
const log = createLogger('digest-service');

async function main() {
  await valkey.connect();
  log.info('Valkey connected');

  await db.$connect();
  log.info('PostgreSQL connected');

  const ch = await connect(env.rabbitmqUrl);
  log.info('RabbitMQ connected');

  await consume(ch, QUEUES.TELEMETRY_ARRIVED, telemetryConsumer(ch));
  await consume(ch, QUEUES.DEVICE_STATE_CHANGED, deviceStatusConsumer(ch));
  await consume(ch, QUEUES.DEVICE_HEARTBEAT, deviceHeartbeatConsumer());
  await consume(ch, QUEUES.ACTION_REQUESTED, actionRequestedConsumer(ch));
  await consume(ch, QUEUES.ACTION_RESULT, actionResultConsumer(ch));
  await consume(ch, QUEUES.PICTURE_REQUESTED, pictureRequestedConsumer(ch));
  await consume(ch, QUEUES.OTA_INCOMING, otaIncomingConsumer(ch));
  log.info(
    'consumers started (telemetry, device-status, device-heartbeat, action-requested, action-result, picture-requested, ota-incoming)',
  );

  const app = express();
  app.use(createHttpLogger(log));
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.listen(env.port, () => log.info({ port: env.port }, 'digest-service listening'));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
