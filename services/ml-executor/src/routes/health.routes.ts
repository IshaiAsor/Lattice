import { Router } from 'express';
import { listModels } from '../models';
import { getQueueHealth } from '@lattice/queue';

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ml-executor',
    uptime: (Date.now() - startedAt) / 1000,
    models: listModels(),
  });
});

// Readiness, as distinct from liveness above. Kubernetes marks a container Ready the moment it
// is Running unless something says otherwise, so a process whose RabbitMQ consumer has died
// stays Ready, keeps its Service endpoint, and reports Available to the Deployment while doing
// no work at all. 503 here is what makes that visible to the probe, the alerts and ArgoCD.
healthRouter.get('/health/ready', (_req, res) => {
  const queue = getQueueHealth();
  res.status(queue.ok ? 200 : 503).json({
    status: queue.ok ? 'ready' : 'not-ready',
    service: 'ml-executor',
    queue,
  });
});
