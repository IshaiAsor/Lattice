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

// ─── Lifecycle (F10.13) ───────────────────────────────────────────────────────────────────────
//
// Deriving builds a setup; starting it is a separate act, because when the real-world process
// began is something only the user knows. While a setup is not running, nothing it derived acts.

// Start or resume. `phase_key` defaults to where it was parked (else the first phase), and
// `timer`/`elapsed_seconds` position the clock inside that phase — "it started two days ago".
blueprintsRouter.post('/instances/:id/start', async (req, res, next) => {
  try {
    const { phase_key, timer, elapsed_seconds } = req.body ?? {};
    if (phase_key !== undefined && phase_key !== null && typeof phase_key !== 'string') {
      res.status(400).json({ error: 'phase_key must be a string' });
      return;
    }
    const mode = timer ?? 'reset';
    if (mode !== 'reset' && mode !== 'resume' && mode !== 'at') {
      res.status(400).json({ error: 'timer must be reset, resume or at' });
      return;
    }
    if (mode === 'at' && !Number.isInteger(elapsed_seconds)) {
      res.status(400).json({ error: 'elapsed_seconds (a whole number) is required when timer=at' });
      return;
    }
    res.json(
      await blueprintInstancesService.start(
        req.user!.id,
        Number(req.params.id),
        phase_key ?? null,
        mode,
        mode === 'at' ? Number(elapsed_seconds) : 0,
      ),
    );
  } catch (err) {
    next(err);
  }
});

// Park it: banks the run, stops the clock, remembers the phase, holds every automation.
blueprintsRouter.post('/instances/:id/stop', async (req, res, next) => {
  try {
    res.json(await blueprintInstancesService.stop(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Back to never-started. Discards the time banks only — bindings, tuning and the derived
// automations all survive, which is what separates this from DELETE.
blueprintsRouter.post('/instances/:id/reset-lifecycle', async (req, res, next) => {
  try {
    res.json(await blueprintInstancesService.reset(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Manual phase change — the counterpart to automation-worker's auto-advance cron. Writes the phase
// columns and the phase's time bank; no rule, scene or pipeline row is touched.
//
// `timer` says what the phase being entered starts from: `reset` from zero (the default, and what
// every caller did before banks existed), `resume` from the time it banked on an earlier visit, or
// `at` from a value the caller names in `elapsed_seconds`.
blueprintsRouter.put('/instances/:id/phase', async (req, res, next) => {
  try {
    const { phase_key, timer, elapsed_seconds } = req.body ?? {};
    if (typeof phase_key !== 'string' || !phase_key.trim()) {
      res.status(400).json({ error: 'phase_key is required' });
      return;
    }
    const mode = timer ?? 'reset';
    if (mode !== 'reset' && mode !== 'resume' && mode !== 'at') {
      res.status(400).json({ error: 'timer must be reset, resume or at' });
      return;
    }
    if (mode === 'at' && !Number.isInteger(elapsed_seconds)) {
      res.status(400).json({ error: 'elapsed_seconds (a whole number) is required when timer=at' });
      return;
    }
    res.json(
      await blueprintInstancesService.setPhase(
        req.user!.id,
        Number(req.params.id),
        phase_key,
        mode,
        mode === 'at' ? Number(elapsed_seconds) : 0,
      ),
    );
  } catch (err) {
    next(err);
  }
});

// Set (or clear, with value null) the user's own value for one parameter. An override is its own
// row on the instance, so this never edits a derived rule, never touches the shared blueprint, and
// reconcile can never clobber it. Optional `phase_key` scopes it to one phase; omitted means every
// phase.
blueprintsRouter.put('/instances/:id/params/:key', async (req, res, next) => {
  try {
    const { value, phase_key } = req.body ?? {};
    if (phase_key !== undefined && phase_key !== null && typeof phase_key !== 'string') {
      res.status(400).json({ error: 'phase_key must be a string' });
      return;
    }
    res.json(
      await blueprintInstancesService.setOverride(
        req.user!.id,
        Number(req.params.id),
        req.params.key!,
        value === null || value === undefined ? null : String(value),
        phase_key ?? null,
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
