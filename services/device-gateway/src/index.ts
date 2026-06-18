import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import express from 'express';
import http from 'http';
import { env } from './config/env.config';
import { initQueue } from './queue';
import { healthRouter } from './routes/health.routes';
import { provisioningRouter } from './routes/provisioning.routes';
import { deviceConfigurationRouter } from './routes/device-configuration.routes';
import { deviceUpdateRouter } from './routes/device-update.routes';
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

  // CORS for browser UI (Angular backoffice on a different origin/subdomain).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && env.allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.use('/api/provisioning', provisioningRouter);
  app.use('/api/device', deviceConfigurationRouter);
  app.use('/api/devices', deviceUpdateRouter);
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
