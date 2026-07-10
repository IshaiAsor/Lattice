import { initOTel } from '@lattice/otel';
import { createLogger, createHttpLogger } from '@lattice/logger';
import express from 'express';
import { env } from './config/env.config';
import { globalRateLimiter } from './middlewares/rate.limiter.middleware';
import { exceptionMiddleware } from './middlewares/exception.middleware';
import { healthRouter } from './routes/health.routes';
import { authRouter } from './routes/auth.routes';
import { usersRouter } from './routes/users.routes';
import { adminCatalogRouter } from './routes/admin.catalog.routes';
import { deviceMgmtRouter } from './routes/device.mgmt.routes';
import { userActionsRouter } from './routes/user.actions.routes';
import { actionGroupsRouter } from './routes/action.groups.routes';
import { rulesRouter } from './routes/rules.routes';
import { pipelinesRouter } from './routes/pipelines.routes';
import { notificationsRouter } from './routes/notifications.routes';
import { getChannel } from './queue';

// OTel must be initialised before any other imports that could create spans.
const { metricsHandler } = initOTel('api');

const log = createLogger('api');

function main() {
  const app = express();
  app.use(createHttpLogger(log));
  app.set('trust proxy', 1); // behind Traefik — honour X-Forwarded-For for rate limiting/audit.
  // Default 100kb is too small for a dry-run sensor override carrying a base64 camera frame.
  app.use(express.json({ limit: '8mb' }));

  // CORS for the Angular backoffice (separate origin/subdomain).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && env.allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));

  app.use(globalRateLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/admin/catalog', adminCatalogRouter);
  app.use('/api/devices', deviceMgmtRouter);
  app.use('/api/actions', userActionsRouter);
  app.use('/api/action-groups', actionGroupsRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/pipelines', pipelinesRouter);
  app.use('/api/notifications', notificationsRouter);

  app.use(exceptionMiddleware);

  // Pre-connect to RabbitMQ so the first pipeline trigger isn't slow.
  getChannel().catch((err) =>
    log.warn({ err }, 'RabbitMQ not yet available — will retry on first pipeline trigger'),
  );

  app.listen(env.port, () => {
    log.info({ port: env.port }, 'api listening');
  });
}

main();
