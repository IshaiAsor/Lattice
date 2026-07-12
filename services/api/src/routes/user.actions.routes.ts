import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { userActionsService } from '../services/user.actions.service';

export const userActionsRouter = Router();

userActionsRouter.use(requireAppToken);

userActionsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await userActionsService.listUserActions(req.user!.id));
  } catch (err) {
    next(err);
  }
});

// Reorder must be declared before '/:id' so 'order' isn't captured as an id.
userActionsRouter.put('/order', async (req, res, next) => {
  try {
    const { orderedIds } = req.body ?? {};
    if (!Array.isArray(orderedIds)) {
      res.status(400).json({ error: 'orderedIds array is required' });
      return;
    }
    await userActionsService.reorderActions(req.user!.id, orderedIds.map(Number));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// Latest camera frame for on-load display (F6.7): 200 {frame, capturedAt} or 204 if none yet.
userActionsRouter.get('/:id/last-frame', async (req, res, next) => {
  try {
    const frame = await userActionsService.getLastFrame(req.user!.id, Number(req.params.id));
    if (frame === null) {
      res.sendStatus(204);
      return;
    }
    res.json(frame);
  } catch (err) {
    next(err);
  }
});

userActionsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { name, group_id, telemetry_interval_ms, default_trait_id } = req.body ?? {};
    await userActionsService.updateAction(req.user!.id, Number(req.params.id), {
      name,
      group_id,
      telemetry_interval_ms,
      default_trait_id,
    });
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

userActionsRouter.put('/:id/behaviors', async (req, res, next) => {
  try {
    const { behaviors } = req.body ?? {};
    if (!Array.isArray(behaviors)) {
      res.status(400).json({ error: 'behaviors array is required' });
      return;
    }
    await userActionsService.setActionBehaviors(req.user!.id, Number(req.params.id), behaviors);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

userActionsRouter.delete('/:id', async (req, res, next) => {
  try {
    await userActionsService.deleteAction(req.user!.id, Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
