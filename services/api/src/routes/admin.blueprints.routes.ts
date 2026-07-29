import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { blueprintsAdminService } from '../services/blueprints.admin.service';

// Admin blueprint authoring. Until the builder UI lands (F10.9) `POST /import` is the authoring
// surface — the same document shape F12.1 will accept.
export const adminBlueprintsRouter = Router();

adminBlueprintsRouter.use(requireAppToken, requireAdmin);

adminBlueprintsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await blueprintsAdminService.listBlueprints());
  } catch (err) {
    next(err);
  }
});

adminBlueprintsRouter.post('/import', async (req, res, next) => {
  try {
    res.status(201).json(await blueprintsAdminService.importBlueprint(req.body));
  } catch (err) {
    next(err);
  }
});

// Validate a document without saving it. Declared before `/:id` routes so "validate" is never
// read as an id, and separate from `/:id/validate` because the builder needs to check what is on
// screen: an import always lands as a draft and bumps a published blueprint's version, so
// "save then validate" is not a harmless substitute.
adminBlueprintsRouter.post('/validate', async (req, res, next) => {
  try {
    const problems = await blueprintsAdminService.validateDocument(req.body);
    res.json({ valid: problems.length === 0, problems });
  } catch (err) {
    next(err);
  }
});

adminBlueprintsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(await blueprintsAdminService.getBlueprint(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

adminBlueprintsRouter.get('/:id/validate', async (req, res, next) => {
  try {
    const problems = await blueprintsAdminService.validateBlueprint(Number(req.params.id));
    res.json({ valid: problems.length === 0, problems });
  } catch (err) {
    next(err);
  }
});

adminBlueprintsRouter.post('/:id/publish', async (req, res, next) => {
  try {
    res.json(await blueprintsAdminService.publishBlueprint(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

adminBlueprintsRouter.delete('/:id', async (req, res, next) => {
  try {
    await blueprintsAdminService.deleteBlueprint(Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});
