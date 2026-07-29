import { initOTel } from '@lattice/otel';
const { metricsHandler } = initOTel('google-home');

import { createLogger, createHttpLogger } from '@lattice/logger';
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

  await consume<ActionResultPayload>(
    ch,
    QUEUES.ACTION_RESULT_GOOGLE_HOME,
    actionResultConsumer(ch),
  );
  log.info('action-result consumer started');

  const app = express();
  app.set('trust proxy', 1); // behind Traefik — honour X-Forwarded-For for rate limiting/audit.
  app.use(createHttpLogger(log));
  app.use(cors());
  app.use(express.json());
  // Google's OAuth token exchange (POST /api/google/token) is application/x-www-form-urlencoded,
  // as is the Basic-auth-less client-credential body — without this the body is unparsed and the
  // client check fails with invalid_client.
  app.use(express.urlencoded({ extended: true }));

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
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
