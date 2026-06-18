import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import { connect, consume, QUEUES } from '@lattice/queue';
import express from 'express';
import cron from 'node-cron';
import { env } from './config/env.config';
import { db } from './db/client';
import { rulesEvaluateConsumer } from './consumers/rules-evaluate.consumer';
import { rulesEngine } from './services/rules.engine';
import { healthRouter } from './routes/health.routes';

const { metricsHandler } = initOTel('automation-worker');
const log = createLogger('automation-worker');

async function main() {
  await db.$connect();
  log.info('PostgreSQL connected');

  const ch = await connect(env.rabbitmqUrl);
  log.info('RabbitMQ connected');

  await consume(ch, QUEUES.RULES_EVALUATE, rulesEvaluateConsumer(ch));
  log.info('consumer started (rules-evaluate)');

  cron.schedule('*/10 * * * * *', () => rulesEngine.evaluateScheduledRules(ch));
  log.info('scheduled rules cron started (every 10 seconds)');

  const app = express();
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.listen(env.port, () => log.info({ port: env.port }, 'automation-worker listening'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
