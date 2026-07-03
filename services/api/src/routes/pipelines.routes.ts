import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { pipelinesService } from '../services/pipelines.service';
import { pipelinesRunsService } from '../services/pipelines-runs.service';

export const pipelinesRouter = Router();

pipelinesRouter.use(requireAppToken);

pipelinesRouter.get('/ml-models', async (_req, res, next) => {
  try {
    res.json(await pipelinesService.listMlModels());
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.get('/', async (req, res, next) => {
  try {
    res.json(await pipelinesService.list(req.user!.id));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await pipelinesService.create(req.user!.id, req.body));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(await pipelinesService.get(req.user!.id, Number(req.params['id'])));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.put('/:id', async (req, res, next) => {
  try {
    res.json(await pipelinesService.update(req.user!.id, Number(req.params['id']), req.body));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.patch('/:id/toggle', async (req, res, next) => {
  try {
    await pipelinesService.setEnabled(req.user!.id, Number(req.params['id']), req.body?.enabled === true);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.delete('/:id', async (req, res, next) => {
  try {
    await pipelinesService.remove(req.user!.id, Number(req.params['id']));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const limit  = Math.min(Number(req.query['limit']  ?? 20), 100);
    const offset = Number(req.query['offset'] ?? 0);
    res.json(await pipelinesRunsService.listRuns(req.user!.id, Number(req.params['id']), limit, offset));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.get('/:id/runs/:runId', async (req, res, next) => {
  try {
    res.json(await pipelinesRunsService.getRun(req.user!.id, Number(req.params['id']), Number(req.params['runId'])));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.post('/:id/runs', async (req, res, next) => {
  try {
    res.status(202).json(await pipelinesRunsService.triggerRun(req.user!.id, Number(req.params['id'])));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.post('/:id/runs/dry-run', async (req, res, next) => {
  try {
    res.status(202).json(await pipelinesRunsService.dryRun(req.user!.id, Number(req.params['id']), req.body));
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.post('/:id/runs/:runId/cancel', async (req, res, next) => {
  try {
    await pipelinesRunsService.cancelRun(req.user!.id, Number(req.params['id']), Number(req.params['runId']));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

pipelinesRouter.delete('/:id/runs/:runId', async (req, res, next) => {
  try {
    await pipelinesRunsService.removeRun(req.user!.id, Number(req.params['id']), Number(req.params['runId']));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
