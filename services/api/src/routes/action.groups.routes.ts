import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { actionGroupsService } from '../services/action.groups.service';

export const actionGroupsRouter = Router();

actionGroupsRouter.use(requireAppToken);

actionGroupsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await actionGroupsService.listGroups(req.user!.id));
  } catch (err) {
    next(err);
  }
});

actionGroupsRouter.post('/', async (req, res, next) => {
  try {
    const { name, sort_order } = req.body ?? {};
    res.status(201).json(await actionGroupsService.createGroup(req.user!.id, name, sort_order));
  } catch (err) {
    next(err);
  }
});

actionGroupsRouter.post('/assign', async (req, res, next) => {
  try {
    const { name, actionIds } = req.body ?? {};
    res
      .status(201)
      .json(await actionGroupsService.assignActions(req.user!.id, name, actionIds?.map(Number)));
  } catch (err) {
    next(err);
  }
});

// Reorder must precede '/:id'.
actionGroupsRouter.put('/order', async (req, res, next) => {
  try {
    const { orderedIds } = req.body ?? {};
    if (!Array.isArray(orderedIds)) {
      res.status(400).json({ error: 'orderedIds array is required' });
      return;
    }
    await actionGroupsService.reorderGroups(req.user!.id, orderedIds.map(Number));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

actionGroupsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { name, sort_order } = req.body ?? {};
    res.json(
      await actionGroupsService.updateGroup(req.user!.id, Number(req.params.id), {
        name,
        sort_order,
      }),
    );
  } catch (err) {
    next(err);
  }
});

actionGroupsRouter.delete('/:id', async (req, res, next) => {
  try {
    await actionGroupsService.deleteGroup(req.user!.id, Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
