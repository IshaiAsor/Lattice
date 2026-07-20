import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { scenesService } from '../services/scenes.service';

export const scenesRouter = Router();

scenesRouter.use(requireAppToken);

scenesRouter.get('/', async (req, res, next) => {
  try {
    res.json(await scenesService.list(req.user!.id));
  } catch (err) {
    next(err);
  }
});

scenesRouter.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await scenesService.create(req.user!.id, req.body));
  } catch (err) {
    next(err);
  }
});

scenesRouter.put('/:id', async (req, res, next) => {
  try {
    res.json(await scenesService.update(req.user!.id, Number(req.params.id), req.body));
  } catch (err) {
    next(err);
  }
});

// Fire-and-forget fan-out — 202 Accepted; device acks arrive over the socket, not here.
scenesRouter.post('/:id/execute', async (req, res, next) => {
  try {
    res.status(202).json(await scenesService.execute(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

scenesRouter.delete('/:id', async (req, res, next) => {
  try {
    await scenesService.remove(req.user!.id, Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
