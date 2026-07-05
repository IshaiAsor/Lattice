import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { catalogService } from '../services/catalog.service';

export const adminCatalogRouter = Router();

adminCatalogRouter.use(requireAppToken, requireAdmin);

// ─── Device catalog (build-published; read + curate) ────────────────────
adminCatalogRouter.get('/devices', async (_req, res, next) => {
  try {
    res.json(await catalogService.listDevices());
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.get('/devices/:id', async (req, res, next) => {
  try {
    res.json(await catalogService.getDevice(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.delete('/devices/:id', async (req, res, next) => {
  try {
    await catalogService.deleteDevice(Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.get('/devices/:id/capabilities', async (req, res, next) => {
  try {
    res.json(await catalogService.listCapabilities(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.get('/devices/:id/actions', async (req, res, next) => {
  try {
    res.json(await catalogService.listActions(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.patch(
  '/capabilities/:capabilityId/traits/:traitId/default',
  async (req, res, next) => {
    try {
      await catalogService.setDefaultTrait(
        Number(req.params.capabilityId),
        Number(req.params.traitId),
      );
      res.sendStatus(204);
    } catch (err) {
      next(err);
    }
  },
);
