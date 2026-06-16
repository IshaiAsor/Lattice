import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import { connect } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { healthRouter } from './routes/health.routes';
import { inferRouter } from './routes/infer.routes';
import { setupModelQueues } from './queue/setup';

// OTel must be initialised before any other imports that could create spans.
initOTel('ml-router');

const log = createLogger('ml-router');

async function main() {
  // RabbitMQ — connect and set up per-model consumers.
  const ch = await connect(env.rabbitmqUrl);
  await setupModelQueues(ch, log);
  log.info('RabbitMQ consumers ready');

  // HTTP server.
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(healthRouter);
  app.use(inferRouter);

  app.listen(env.port, () => {
    log.info({ port: env.port }, 'ml-router listening');
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});

