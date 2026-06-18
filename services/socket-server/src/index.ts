import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import { connect } from '@lattice/queue';
import express from 'express';
import http from 'http';
import { env } from './config/env.config';
import { initSocket } from './socket/server';
import { healthRouter } from './routes/health.routes';
import { exceptionMiddleware } from './middlewares/exception.middleware';

const { metricsHandler } = initOTel('socket-server');
const log = createLogger('socket-server');

async function main() {
  const ch = await connect(env.rabbitmqUrl);
  log.info('RabbitMQ connected');

  const app = express();
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.use(exceptionMiddleware);

  const server = http.createServer(app);
  initSocket(server, ch);

  server.listen(env.port, () => log.info({ port: env.port }, 'socket-server listening'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
