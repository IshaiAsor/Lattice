import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import express from 'express';
import http from 'http';
import { env } from './config/env.config';
import { initQueue } from './queue';
import { healthRouter } from './routes/health.routes';
import { provisioningRouter } from './routes/provisioning.routes';
import { deviceConfigurationRouter } from './routes/device-configuration.routes';
import { cameraRouter } from './routes/camera.routes';
import { initCameraStream } from './ws/camera-stream';
import { exceptionMiddleware } from './middlewares/exception.middleware';

// OTel must be initialised before any other imports that could create spans.
const { metricsHandler } = initOTel('device-gateway');

const log = createLogger('device-gateway');

async function main() {
  // Camera frames are published to RabbitMQ — establish the channel before serving.
  await initQueue();
  log.info('RabbitMQ connected');

  const app = express();
  // JSON for provisioning/config; the camera route applies its own raw() parser.
  app.use(express.json());

  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.use('/api/provisioning', provisioningRouter);
  app.use('/api/device', deviceConfigurationRouter);
  app.use('/api/camera', cameraRouter);

  app.use(exceptionMiddleware);

  // Explicit HTTP server so the camera WebSocket can attach to upgrade events.
  const server = http.createServer(app);
  initCameraStream(server);

  server.listen(env.port, () => {
    log.info({ port: env.port }, 'device-gateway listening');
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
