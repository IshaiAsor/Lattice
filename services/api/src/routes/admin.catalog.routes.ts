import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { catalogService } from '../services/catalog.service';
import { sealedTemplatesService } from '../services/sealed-templates.service';

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

// ─── Sealed device templates (admin authoring over the shared catalog) ──────
// Palette: sealed catalog identities the admin composes from (capabilities come from the
// existing GET /devices/:id/capabilities|actions endpoints above).
adminCatalogRouter.get('/sealed/identities', async (_req, res, next) => {
  try {
    res.json(await sealedTemplatesService.listSealedIdentities());
  } catch (err) {
    next(err);
  }
});

adminCatalogRouter.get('/sealed/templates', async (_req, res, next) => {
  try {
    res.json(await sealedTemplatesService.listTemplates());
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.post('/sealed/templates', async (req, res, next) => {
  try {
    res.status(201).json(await sealedTemplatesService.createTemplate(req.body?.name));
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.get('/sealed/templates/:id', async (req, res, next) => {
  try {
    res.json(await sealedTemplatesService.getTemplate(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});
// Which blueprints depend on this template, and which of their references no longer resolve
// (F10.10) — what the editor shows before an edit strands one.
adminCatalogRouter.get('/sealed/templates/:id/usage', async (req, res, next) => {
  try {
    res.json(await sealedTemplatesService.getUsage(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.patch('/sealed/templates/:id', async (req, res, next) => {
  try {
    const { name, targets, entries, force } = req.body ?? {};
    res.json(
      await sealedTemplatesService.updateTemplate(Number(req.params.id), {
        name,
        targets,
        entries,
        force: force === true,
      }),
    );
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.delete('/sealed/templates/:id', async (req, res, next) => {
  try {
    await sealedTemplatesService.deleteTemplate(Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
adminCatalogRouter.post('/sealed/templates/:id/release', async (req, res, next) => {
  try {
    res.json(await sealedTemplatesService.releaseTemplate(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});
