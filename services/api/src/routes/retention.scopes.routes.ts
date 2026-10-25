import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { retentionTiersService } from '../services/retention-tiers.service';

// Per-device and per-action tier lists (F18.12) — the two scopes that make a tank-level sensor
// worth 5-minute buckets stop forcing every switch in the house to the same shape.
//
// A router of its own rather than hanging off the device and action routers, so every retention
// endpoint sits under one prefix and the ownership check has one home. Ownership is enforced in the
// service through the shared `ensureDeviceOwned`/`ensureActionOwned` — 404 for missing, 403 for
// not-yours, the same codes the read API uses, so an id probe learns nothing.

/**
 * Mounted at /api/retention/scopes — per-device and per-action tier lists (F18.12).
 *
 * A separate router rather than hanging off the device/action routers, so every retention endpoint
 * is reachable under one prefix and the ownership check has one home. Ownership is enforced in the
 * service via the shared `ensureDeviceOwned`/`ensureActionOwned` — 404 for missing, 403 for
 * not-yours, the same codes the read API uses, so an id probe learns nothing.
 */
export const retentionScopesRouter = Router();
retentionScopesRouter.use(requireAppToken);

// Every sensor on a device, resolved: own list, what applies and who decided, the fallback, and what
// it stores (F18.20) — the device page's Data tab in one read. Declared BEFORE
// `/devices/:deviceId/:kind`, or `effective` would be parsed as a data kind and refused.
retentionScopesRouter.get('/devices/:deviceId/effective', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.deviceRetention(req.user!.id, Number(req.params.deviceId)),
    );
  } catch (err) {
    next(err);
  }
});

// What each action in one of the user's setups keeps, and who decided it (F18.20) — the setup page's
// Data tab. The user's own list is written through the action routes below.
retentionScopesRouter.get('/setups/:instanceId', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.setupRetention(req.user!.id, Number(req.params.instanceId)),
    );
  } catch (err) {
    next(err);
  }
});

retentionScopesRouter.get('/devices/:deviceId/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.deviceTiers(
        req.user!.id,
        Number(req.params.deviceId),
        req.params.kind,
      ),
    );
  } catch (err) {
    next(err);
  }
});

retentionScopesRouter.put('/devices/:deviceId/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.setDeviceTiers(
        req.user!.id,
        Number(req.params.deviceId),
        req.params.kind,
        req.body ?? {},
      ),
    );
  } catch (err) {
    next(err);
  }
});

retentionScopesRouter.delete('/devices/:deviceId/:kind', async (req, res, next) => {
  try {
    await retentionTiersService.clearDeviceTiers(
      req.user!.id,
      Number(req.params.deviceId),
      req.params.kind,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

retentionScopesRouter.get('/actions/:actionId/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.actionTiers(
        req.user!.id,
        Number(req.params.actionId),
        req.params.kind,
      ),
    );
  } catch (err) {
    next(err);
  }
});

// What actually applies to this action, and which scope decided it — the "inherited from your
// device" line the editor shows.
retentionScopesRouter.get('/actions/:actionId/:kind/effective', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.effectiveForAction(
        req.user!.id,
        Number(req.params.actionId),
        req.params.kind,
      ),
    );
  } catch (err) {
    next(err);
  }
});

retentionScopesRouter.put('/actions/:actionId/:kind', async (req, res, next) => {
  try {
    res.json(
      await retentionTiersService.setActionTiers(
        req.user!.id,
        Number(req.params.actionId),
        req.params.kind,
        req.body ?? {},
      ),
    );
  } catch (err) {
    next(err);
  }
});

retentionScopesRouter.delete('/actions/:actionId/:kind', async (req, res, next) => {
  try {
    await retentionTiersService.clearActionTiers(
      req.user!.id,
      Number(req.params.actionId),
      req.params.kind,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
