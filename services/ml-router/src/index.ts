import { initOTel } from '@lattice/otel';
import { createLogger, createHttpLogger } from '@lattice/logger';
import { connect } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { healthRouter } from './routes/health.routes';
import { initChatWorker } from './handlers/chat.handler';
import { initPipelineCoordinator } from './pipeline/coordinator';
// OTel must be initialised before any other imports that could create spans.
const { metricsHandler } = initOTel('ml-router');

const log = createLogger('ml-router');

async function main() {
  const app = express();
  app.use(createHttpLogger(log));
  app.use(express.json({ limit: '20mb' }));
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.listen(env.port, () => {
    log.info({ port: env.port }, 'ml-router listening');
  });

  // Sync user chat (Redis): edge intents → plan → enrich → generic infer job → relay + audit.
  await initChatWorker();

  // Async system ML executions (RMQ): PIPELINE_TRIGGER → stages on the executor → PIPELINE_RESULT.
  const ch = await connect(env.rabbitmqUrl);
  await initPipelineCoordinator(ch);
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
