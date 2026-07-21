import { Router } from 'express';
import { channels } from '../channels/registry';
import { env } from '../config/env.config';

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
