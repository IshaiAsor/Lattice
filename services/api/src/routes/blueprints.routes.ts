import { Router } from 'express';
import { requireAppToken } from '../middlewares/auth.middleware';
import { blueprintsDeriveService } from '../services/blueprints.derive.service';
import { blueprintInstancesService } from '../services/blueprints.instances.service';
import { blueprintsReconcileService } from '../services/blueprints.reconcile.service';
import { blueprintBindingsService } from '../services/blueprints.bindings.service';

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

// ─── Per-binding lifecycles (F11) ─────────────────────────────────────────────────────────────
//
// A binding of a profiled slot runs a lifecycle of its own. These mirror the setup-level routes
// above exactly, one level down, so each bound device is started, stopped, re-profiled and moved
// between phases independently of the others and of the setup.

blueprintsRouter.get('/instances/:id/bindings', async (req, res, next) => {
  try {
    res.json(await blueprintBindingsService.list(req.user!.id, Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/** Shared body parse for the three timer-bearing binding routes — same contract as the setup's. */
function readTimer(body: unknown): { mode: 'reset' | 'resume' | 'at'; seconds: number } | string {
  const { timer, elapsed_seconds } = (body ?? {}) as Record<string, unknown>;
  const mode = timer ?? 'reset';
  if (mode !== 'reset' && mode !== 'resume' && mode !== 'at')
    return 'timer must be reset, resume or at';
  if (mode === 'at' && !Number.isInteger(elapsed_seconds)) {
    return 'elapsed_seconds (a whole number) is required when timer=at';
  }
  return { mode, seconds: mode === 'at' ? Number(elapsed_seconds) : 0 };
}

blueprintsRouter.post('/bindings/:bindingId/start', async (req, res, next) => {
  try {
    const { phase_key } = req.body ?? {};
    if (phase_key !== undefined && phase_key !== null && typeof phase_key !== 'string') {
      res.status(400).json({ error: 'phase_key must be a string' });
      return;
    }
    const timer = readTimer(req.body);
    if (typeof timer === 'string') {
      res.status(400).json({ error: timer });
      return;
    }
    res.json(
      await blueprintBindingsService.start(
        req.user!.id,
        Number(req.params.bindingId),
        phase_key ?? null,
        timer.mode,
        timer.seconds,
      ),
    );
  } catch (err) {
    next(err);
  }
});

blueprintsRouter.post('/bindings/:bindingId/stop', async (req, res, next) => {
  try {
    res.json(await blueprintBindingsService.stop(req.user!.id, Number(req.params.bindingId)));
  } catch (err) {
    next(err);
  }
});

// `profile_key` re-profiles: the binding goes back to not-started AND follows another lifecycle.
blueprintsRouter.post('/bindings/:bindingId/reset', async (req, res, next) => {
  try {
    const { profile_key } = req.body ?? {};
    if (profile_key !== undefined && profile_key !== null && typeof profile_key !== 'string') {
      res.status(400).json({ error: 'profile_key must be a string' });
      return;
    }
    res.json(
      await blueprintBindingsService.reset(
        req.user!.id,
        Number(req.params.bindingId),
        profile_key ?? null,
      ),
    );
  } catch (err) {
    next(err);
  }
});

// One device's own value for a parameter — the top of the precedence stack (F11.3), and the way to
// make one bound device differ from its siblings without giving it a second lifecycle. Optional
// `phase_key` scopes it to one phase of that device's own lifecycle; omitted means every phase.
blueprintsRouter.put('/bindings/:bindingId/params/:key', async (req, res, next) => {
  try {
    const { value, phase_key } = req.body ?? {};
    if (phase_key !== undefined && phase_key !== null && typeof phase_key !== 'string') {
      res.status(400).json({ error: 'phase_key must be a string' });
      return;
    }
    res.json(
      await blueprintBindingsService.setOverride(
        req.user!.id,
        Number(req.params.bindingId),
        req.params.key!,
        value === null || value === undefined ? null : String(value),
        phase_key ?? null,
        req.user!.role === 'admin',
      ),
    );
  } catch (err) {
    next(err);
  }
});

blueprintsRouter.put('/bindings/:bindingId/phase', async (req, res, next) => {
  try {
    const { phase_key } = req.body ?? {};
    if (typeof phase_key !== 'string' || !phase_key.trim()) {
      res.status(400).json({ error: 'phase_key is required' });
      return;
    }
    const timer = readTimer(req.body);
    if (typeof timer === 'string') {
      res.status(400).json({ error: timer });
      return;
    }
    res.json(
      await blueprintBindingsService.setPhase(
        req.user!.id,
        Number(req.params.bindingId),
        phase_key,
        timer.mode,
        timer.seconds,
      ),
    );
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
        req.user!.role === 'admin',
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
