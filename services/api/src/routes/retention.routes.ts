import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { retentionUsageService } from '../services/retention-usage.service';
import { retentionTiersService } from '../services/retention-tiers.service';
import { retentionActivityService } from '../services/retention-activity.service';

// The signed-in user's own tier lists, storage usage, and their own sweeps (F18.15).
//
// SECURITY: `scopeUserId` is passed POSITIONALLY as `req.user!.id` at every call site below. There
// is no body field anywhere that reaches it, which is what stops a request deciding whose history
// gets deleted. The sibling admin router passes `null` for the same parameter.
//
// Siblings: retention.buckets.routes.ts (the shared vocabulary), retention.scopes.routes.ts
// (per-device and per-action lists), admin.retention.routes.ts (the platform layer).

/** Mounted at /api/retention — the signed-in user's own tier lists and sweeps. */
export const retentionRouter = Router();
retentionRouter.use(requireAppToken);

retentionRouter.get('/', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.mine(req.user!.id));
  } catch (err) {
    next(err);
  }
});

retentionRouter.get('/usage', async (req, res, next) => {
  try {
    res.json(await retentionUsageService.usage(req.user!.id));
  } catch (err) {
    next(err);
  }
});

retentionRouter.get('/preview', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.preview(req.user!.id));
  } catch (err) {
    next(err);
  }
});

retentionRouter.post('/apply', async (req, res, next) => {
  try {
    res
      .status(202)
      .json(await retentionTiersService.requestSweep('user', req.user!.id, req.user!.id));
  } catch (err) {
    next(err);
  }
});

// Their own trail, plus platform-level entries — which are the ANSWER to "why did my window
// move", and state nothing private. Another user's entries are excluded by the service.
retentionRouter.get('/activity', async (req, res, next) => {
  try {
    res.json(
      await retentionActivityService.list(req.user!.id, {
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

retentionRouter.get('/runs', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.runs(req.user!.id));
  } catch (err) {
    next(err);
  }
});

retentionRouter.get('/runs/:id', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.run(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

retentionRouter.put('/:kind', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.setMine(req.user!.id, req.params.kind, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

// Reset = delete the rows, so the user follows the platform list again (including future changes
// to it). Writing today's platform list into them would freeze them at today's values.
retentionRouter.delete('/:kind', async (req, res, next) => {
  try {
    res.json(await retentionTiersService.resetMine(req.user!.id, req.params.kind));
  } catch (err) {
    next(err);
  }
});
