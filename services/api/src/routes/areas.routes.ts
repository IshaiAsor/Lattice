import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { areasService } from '../services/areas.service';

export const areasRouter = Router();

areasRouter.use(requireAppToken);

areasRouter.get('/', async (req, res, next) => {
  try {
    res.json(await areasService.listAreas(req.user!.id));
  } catch (err) {
    next(err);
  }
});

areasRouter.post('/', async (req, res, next) => {
  try {
    const { name, sort_order } = req.body ?? {};
    res.status(201).json(await areasService.createArea(req.user!.id, name, sort_order));
  } catch (err) {
    next(err);
  }
});

// Assign devices to an area (area_id null clears the tag). Must precede '/:id'.
areasRouter.post('/assign', async (req, res, next) => {
  try {
    const { areaId, deviceIds } = req.body ?? {};
    await areasService.assignDevices(
      req.user!.id,
      areaId === null || areaId === undefined ? null : Number(areaId),
      Array.isArray(deviceIds) ? deviceIds.map(Number) : deviceIds,
    );
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// Reorder must precede '/:id'.
areasRouter.put('/order', async (req, res, next) => {
  try {
    const { orderedIds } = req.body ?? {};
    if (!Array.isArray(orderedIds)) {
      res.status(400).json({ error: 'orderedIds array is required' });
      return;
    }
    await areasService.reorderAreas(req.user!.id, orderedIds.map(Number));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

areasRouter.patch('/:id', async (req, res, next) => {
  try {
    const { name, sort_order } = req.body ?? {};
    res.json(
      await areasService.updateArea(req.user!.id, Number(req.params.id), { name, sort_order }),
    );
  } catch (err) {
    next(err);
  }
});

areasRouter.delete('/:id', async (req, res, next) => {
  try {
    await areasService.deleteArea(req.user!.id, Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
