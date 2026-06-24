import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import { connect } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { healthRouter } from './routes/health.routes';
import { inferRouter } from './routes/infer.routes';
import { setupModelQueues } from './queue/setup';
import { initInferWorker } from './handlers/redis.infer.handler';
// OTel must be initialised before any other imports that could create spans.
const { metricsHandler } = initOTel('ml-executor');

const log = createLogger('ml-executor');

async function main() {
  // RabbitMQ — connect and set up per-model consumers.
  const ch = await connect(env.rabbitmqUrl);
  await setupModelQueues(ch, log);
  log.info('RabbitMQ consumers ready');

  // HTTP server.
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.use(inferRouter);

  app.listen(env.port, () => {
    log.info({ port: env.port }, 'ml-executor listening');
  });

  await initInferWorker();
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
