import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { blueprintsDeriveService } from '../services/blueprints.derive.service';
import { blueprintInstancesService } from '../services/blueprints.instances.service';
import { blueprintsReconcileService } from '../services/blueprints.reconcile.service';

// User-facing blueprints (F10.3/F10.4): browse what is derivable against your own fleet, preview
// the slot matching, derive an instance, then read and tune it. Authoring lives behind
// /api/admin/blueprints.
export const blueprintsRouter = Router();

blueprintsRouter.use(requireAppToken);

blueprintsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await blueprintsDeriveService.listDerivable(req.user!.id));
  } catch (err) {
    next(err);
  }
});

// ─── Instances — all declared before '/:id' so a literal 'instances' isn't read as an id ──────

blueprintsRouter.get('/instances', async (req, res, next) => {
  try {
    res.json(await blueprintInstancesService.list(req.user!.id));
  } catch (err) {
    next(err);
  }
});

blueprintsRouter.get('/instances/:id', async (req, res, next) => {
  try {
    res.json(await blueprintInstancesService.get(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Manual phase change — the counterpart to automation-worker's auto-advance cron. Writes one
// column; no rule, scene or pipeline row is touched.
blueprintsRouter.put('/instances/:id/phase', async (req, res, next) => {
  try {
    const { phase_key } = req.body ?? {};
    if (typeof phase_key !== 'string' || !phase_key.trim()) {
      res.status(400).json({ error: 'phase_key is required' });
      return;
    }
    res.json(
      await blueprintInstancesService.setPhase(req.user!.id, Number(req.params.id), phase_key),
    );
  } catch (err) {
    next(err);
  }
});

// Set (or clear, with value null) the user's own value for one parameter. An override is its own
// row, so this never edits a derived rule and reconcile can never clobber it.
blueprintsRouter.put('/instances/:id/params/:key', async (req, res, next) => {
  try {
    const { value } = req.body ?? {};
    res.json(
      await blueprintInstancesService.setOverride(
        req.user!.id,
        Number(req.params.id),
        req.params.key!,
        value === null || value === undefined ? null : String(value),
      ),
    );
  } catch (err) {
    next(err);
  }
});

// What has diverged from the blueprint: entities the user edited, and params they pinned.
blueprintsRouter.get('/instances/:id/drift', async (req, res, next) => {
  try {
    res.json(await blueprintsReconcileService.driftReport(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Pull the setup up to the blueprint's current definition. Runs automatically on publish; exposed
// here so a user can re-run it after fixing a binding that made an entity unresolvable.
blueprintsRouter.post('/instances/:id/reconcile', async (req, res, next) => {
  try {
    await blueprintInstancesService.get(req.user!.id, Number(req.params.id)); // ownership
    res.json(await blueprintsReconcileService.reconcileInstance(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Hand one edited entity back to the blueprint.
blueprintsRouter.post('/instances/:id/reset/:kind/:entityId', async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (kind !== 'scene' && kind !== 'rule' && kind !== 'pipeline') {
      res.status(400).json({ error: 'kind must be scene, rule or pipeline' });
      return;
    }
    res.json(
      await blueprintsReconcileService.resetEntity(
        req.user!.id,
        Number(req.params.id),
        kind,
        Number(req.params.entityId),
      ),
    );
  } catch (err) {
    next(err);
  }
});

blueprintsRouter.delete('/instances/:id', async (req, res, next) => {
  try {
    await blueprintsDeriveService.removeInstance(req.user!.id, Number(req.params.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// ─── Blueprint (definition) routes ────────────────────────────────────────────────────────────

// Dry run: which devices would bind to which slot, and what is unmet.
blueprintsRouter.get('/:id/preview', async (req, res, next) => {
  try {
    res.json(await blueprintsDeriveService.preview(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

blueprintsRouter.post('/:id/derive', async (req, res, next) => {
  try {
    const { name, bindings } = req.body ?? {};
    res.status(201).json(
      await blueprintsDeriveService.derive(req.user!.id, Number(req.params.id), {
        name,
        bindings,
      }),
    );
  } catch (err) {
    next(err);
  }
});
