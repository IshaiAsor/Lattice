import { Router } from 'express';

const startedAt = Date.now();

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'device-gateway',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
});
