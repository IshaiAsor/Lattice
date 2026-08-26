import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { retentionUsageService } from '../services/retention-usage.service';
import { retentionTiersService } from '../services/retention-tiers.service';
import { retentionActivityService } from '../services/retention-activity.service';

// The platform layer: the tier list every user starts on, the ceilings none may exceed, the
// blueprint definitions users inherit, and the job history (F18.14).
//
// Blueprint tiers are admin-only by design — a user cannot edit the definition their instance
// inherits; they override it at their own device or action scope, which sits above blueprint in the
// resolution order.

/** Mounted at /api/admin/retention — the platform list, ceilings, blueprint tiers and job history. */
export const adminRetentionRouter = Router();
adminRetentionRouter.use(requireAppToken, requireAdmin);

adminRetentionRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await retentionTiersService.listPolicies());
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/usage', async (_req, res, next) => {
  try {
    res.json(await retentionUsageService.usage(null));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/preview', async (_req, res, next) => {
  try {
    res.json(await retentionTiersService.preview(null));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.post('/apply', async (req, res, next) => {
  try {
    res.status(202).json(await retentionTiersService.requestSweep('admin', req.user!.id, null));
  } catch (err) {
    next(err);
  }
});

// The whole trail, every scope and every user. `null` is the admin view.
adminRetentionRouter.get('/activity', async (req, res, next) => {
  try {
    res.json(
      await retentionActivityService.list(null, {
        action: typeof req.query['action'] === 'string' ? req.query['action'] : undefined,
        dataKind: typeof req.query['kind'] === 'string' ? req.query['kind'] : undefined,
        limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
        before: req.query['before'] ? Number(req.query['before']) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/runs', async (_req, res, next) => {
  try {
    res.json(await retentionTiersService.runs(null));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/runs/:id', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.run(null, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/blueprints/:blueprintId', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.blueprintTiers(Number(req.params.blueprintId)));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.put(
  '/blueprints/:blueprintId/:slotKey/:actionName/:kind',
  async (req, res, next) => {
    try {
      res.json(
        await retentionTiersService.setBlueprintTiers(
          Number(req.params.blueprintId),
          req.params.slotKey,
          req.params.actionName,
          req.params.kind,
          req.body ?? {},
          req.user!.id,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

adminRetentionRouter.put('/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.setPolicyTiers(req.user!.id, req.params.kind, req.body ?? {}),
    );
  } catch (err) {
    next(err);
  }
});
