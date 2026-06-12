import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { errorHandler } from '../../middlewares/exception.middleware';
import provisioningRoutes from '../../routes/provisioning.routes';

/**
 * Builds the Express app with only the provisioning routes mounted.
 * Does NOT start any listeners, MQTT connections, or RabbitMQ consumers.
 * Safe to create once per test file and reuse across tests.
 */
export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/provision', provisioningRoutes);

  app.use(errorHandler);
  return app;
}
