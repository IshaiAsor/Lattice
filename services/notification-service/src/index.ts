import { initOTel } from '@lattice/otel';
import { createLogger, createHttpLogger } from '@lattice/logger';
import { connect, assertNotificationQueues } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { healthRouter } from './routes/health.routes';
import { exceptionMiddleware } from './middlewares/exception.middleware';
import { valkey } from './cache/valkey';
import { logChannelStatus } from './channels/registry';
import { startConsumers } from './consumers/notification.consumer';

const { metricsHandler } = initOTel('notification-service');
const log = createLogger('notification-service');

async function main() {
  await valkey.connect();
  log.info('Valkey connected');

  const ch = await connect(env.rabbitmqUrl);
  await assertNotificationQueues(ch);
  log.info('RabbitMQ connected; notification queues bound');

  logChannelStatus();
  await startConsumers(ch);

  const app = express();
  app.use(createHttpLogger(log));
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.use(exceptionMiddleware);

  app.listen(env.port, () => log.info({ port: env.port }, 'notification-service listening'));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
