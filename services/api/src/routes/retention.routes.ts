import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { retentionService } from '../services/retention.service';

// Two routers because there are two audiences with different powers, not one router with branches:
// a user edits their own window, an admin edits the default everyone starts on and the ceiling
// nobody may exceed. Thin delegates throughout.

/** Mounted at /api/retention — the signed-in user's own policy. */
export const retentionRouter = Router();
retentionRouter.use(requireAppToken);

retentionRouter.get('/', async (req, res, next) => {
  try {
    res.json(await retentionService.mine(req.user!.id));
  } catch (err) {
    next(err);
  }
});

retentionRouter.get('/usage', async (req, res, next) => {
  try {
    res.json(await retentionService.usage(req.user!.id));
  } catch (err) {
    next(err);
  }
});

retentionRouter.put('/:kind', async (req, res, next) => {
  try {
    res.json(await retentionService.setMine(req.user!.id, req.params.kind, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

// Reset = delete the override row, so the user follows the platform default again (including
// future changes to it).
retentionRouter.delete('/:kind', async (req, res, next) => {
  try {
    res.json(await retentionService.resetMine(req.user!.id, req.params.kind));
  } catch (err) {
    next(err);
  }
});

/** Mounted at /api/admin/retention — platform defaults, ceilings and the override overview. */
export const adminRetentionRouter = Router();
adminRetentionRouter.use(requireAppToken, requireAdmin);

adminRetentionRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await retentionService.listPolicies());
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/usage', async (_req, res, next) => {
  try {
    res.json(await retentionService.usage(null));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/overrides', async (_req, res, next) => {
  try {
    res.json(await retentionService.overrides());
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.put('/:kind', async (req, res, next) => {
  try {
    res.json(await retentionService.updatePolicy(req.user!.id, req.params.kind, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});
