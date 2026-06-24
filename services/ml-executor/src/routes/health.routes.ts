import { Router } from 'express';
import { listModels } from '../models';

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
