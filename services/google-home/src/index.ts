import { initOTel } from '@lattice/otel';
const { metricsHandler } = initOTel('google-home');

import { createLogger } from '@lattice/logger';
import { connect, consume, QUEUES } from '@lattice/queue';
import type { ActionResultPayload } from '@lattice/queue';
import express from 'express';
import cors from 'cors';
import config from './config/env.config';
import { createSmarthomeRouter } from './routes/google.smarthome.routes';
import googleAuthRouter from './routes/google.auth.routes';
import healthRouter from './routes/health.routes';
import { actionResultConsumer } from './consumers/action-result.consumer';
import { errorMiddleware } from './middlewares/error.middleware';

const log = createLogger('google-home');

async function main() {
  const ch = await connect(config.rabbitmqUrl);
  log.info('RabbitMQ connected');

  await consume<ActionResultPayload>(ch, QUEUES.ACTION_RESULT_GOOGLE_HOME, actionResultConsumer(ch));
  log.info('action-result consumer started');

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/health', healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.use('/api/google', googleAuthRouter);
  app.use('/api/google/smarthome', createSmarthomeRouter(ch));

  app.use(errorMiddleware);

  app.listen(config.port, () => {
    log.info({ port: config.port }, 'google-home service listening');
  });
}

main().catch((err) => {
  console.error('[google-home] Fatal startup error:', err);
  process.exit(1);
});

