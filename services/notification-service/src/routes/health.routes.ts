import { Router } from 'express';
import { channels } from '../channels/registry';
import { env } from '../config/env.config';
import { getQueueHealth } from '@lattice/queue';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'notification-service',
    uptime: process.uptime(),
    // Which deployment outbound notifications are tagged with (LATTICE_ENV).
    environment: env.environment,
    // Which channel adapters loaded a real provider vs. fell back to no-op/log.
    channels: channels.map((c) => ({ name: c.name, enabled: c.enabled })),
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
    service: 'notification-service',
    queue,
  });
});
