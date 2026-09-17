import { Router } from 'express';
import { requireAppToken, requireAdmin } from '../middlewares/auth.middleware';
import { retentionUsageService } from '../services/retention-usage.service';
import { retentionTiersService } from '../services/retention-tiers.service';
import { retentionActivityService } from '../services/retention-activity.service';
import { retentionScheduleService } from '../services/retention-schedule.service';

// The platform layer: the tier list every user starts on, the ceilings none may exceed, the
// blueprint and sealed template definitions users inherit, and the job history (F18.14).
//
// Blueprint and sealed tiers are admin-only by design — a user cannot edit the definition their
// device inherits; they override it at their own device or action scope, which sits above both in
// the resolution order.

/** Mounted at /api/admin/retention — platform list, ceilings, inherited tiers and job history. */
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

// When each of the four jobs runs (F18.17 / F18.18). The build cadence is still DERIVED from the
// tier lists by default — the only place an admin can see that adding a finer tier moved it — and
// the three destructive jobs each carry a schedule an admin sets here rather than in an env var.
adminRetentionRouter.get('/schedule', async (_req, res, next) => {
  try {
    res.json(await retentionScheduleService.schedule());
  } catch (err) {
    next(err);
  }
});

// PUT before the `/:kind` handler at the bottom of this file, which is a bare parameter and would
// otherwise match `/schedule/data_sweep` as the kind `schedule`. Express matches in registration
// order, so the literal prefix has to come first — the same trap the four retention routers hit when
// they were split.
adminRetentionRouter.put('/schedule/:job', async (req, res, next) => {
  try {
    res.json(
      await retentionScheduleService.setSchedule(req.user!.id, req.params.job, req.body ?? {}),
    );
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.get('/runs', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.runs(null, 50, req.query['rollups'] === 'true'));
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

// Sealed template tiers (F18.21) — one list per (entry, kind), inherited by every device the
// template covers. Admin-only for the same reason blueprint tiers are.
adminRetentionRouter.get('/sealed/:templateId', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.sealedTiers(Number(req.params.templateId)));
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.put('/sealed/:templateId/:actionName/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.setSealedTiers(
        Number(req.params.templateId),
        req.params.actionName,
        req.params.kind,
        req.body ?? {},
        req.user!.id,
      ),
    );
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.delete('/sealed/:templateId/:actionName/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.clearSealedTiers(
        Number(req.params.templateId),
        req.params.actionName,
        req.params.kind,
        req.user!.id,
      ),
    );
  } catch (err) {
    next(err);
  }
});

adminRetentionRouter.put('/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.setPolicyTiers(req.user!.id, req.params.kind, req.body ?? {}),
    );
  } catch (err) {
    next(err);
  }
});
