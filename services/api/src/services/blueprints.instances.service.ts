import { db, Prisma } from '../db';
import {
  resolveParamWithSource,
  buildParamContext,
  accruedOnEnter,
  phaseDurationSeconds,
  phaseElapsedSeconds,
  secondsBetween,
  ALL_PHASES,
  MAX_ACCRUED_SECONDS,
  type ParamContext,
  type PhaseTimerMode,
} from '@lattice/params';
import { createLogger } from '@lattice/logger';

const log = createLogger('api:blueprints-instances');

// Blueprint instances (F10.4) — reading and tuning a derived setup: what it bound, which phase
// it is in, and what every parameter currently resolves to.
//
// The resolved value is computed here rather than stored, from the same @lattice/params
// precedence the automation-worker uses at evaluation time. That is the point: the instance page
// must show exactly what the rules will act on, and the only way to guarantee that is to run the
// same resolver over the same three layers rather than duplicating the precedence in the UI.

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message = 'Setup not found'): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

// Hoisted so the payload type can be named (TS2742).
const instanceInclude = {
  bindings: true,
  overrides: true,
  phase_state: true,
  area: { select: { id: true, name: true } },
  current_phase: { select: { id: true, key: true, name: true, ordinal: true } },
  blueprint: {
    select: {
      id: true,
      key: true,
      name: true,
      version: true,
      context_notes: true,
      params: { orderBy: { sort_order: 'asc' }, select: paramSelect() },
      phases: { orderBy: { ordinal: 'asc' }, select: phaseSelect() },
      slots: { orderBy: { sort_order: 'asc' }, select: { key: true, label: true } },
    },
  },
  scenes: { select: { id: true, name: true, blueprint_key: true, user_modified: true } },
  rules: {
    select: { id: true, name: true, enabled: true, blueprint_key: true, user_modified: true },
  },
  pipelines: {
    select: { id: true, name: true, enabled: true, blueprint_key: true, user_modified: true },
  },
} satisfies Prisma.BlueprintInstanceInclude;

function paramSelect() {
  return {
    key: true,
    label: true,
    default_value: true,
    unit: true,
    user_tunable: true,
  } satisfies Prisma.BlueprintParamSelect;
}
function phaseSelect() {
  return {
    id: true,
    key: true,
    name: true,
    ordinal: true,
    duration_value: true,
    duration_unit: true,
    auto_advance: true,
    context_notes: true,
    targets: { select: { param_key: true, value: true } },
  } satisfies Prisma.BlueprintPhaseSelect;
}

type FullInstance = Prisma.BlueprintInstanceGetPayload<{ include: typeof instanceInclude }>;

/** Which layer supplied a resolved value — what the UI renders as "your value" vs "from phase". */
export type ParamSource = 'phase_override' | 'override' | 'phase' | 'default';

/** One phase's column in the settings matrix: what this param resolves to *in that phase*. */
export interface ParamPhaseCell {
  phase_key: string;
  phase_name: string;
  is_current: boolean;
  value: string | null;
  source: ParamSource;
  /** The blueprint's target for this phase, if it sets one. */
  phase_target: string | null;
  /** The user's own row for this phase, if they set one. */
  phase_override: string | null;
}

export interface ResolvedParam {
  key: string;
  label: string;
  unit: string | null;
  user_tunable: boolean;
  /** What a rule referencing this param resolves to right now, in the *current* phase. */
  value: string | null;
  source: ParamSource;
  default_value: string;
  phase_value: string | null;
  /** The user's all-phases row, if any. */
  override_value: string | null;
  /**
   * Every phase, resolved — so the page can show what the whole lifecycle is tuned to without the
   * user having to advance through it to find out. Empty for a blueprint with no phases.
   */
  phases: ParamPhaseCell[];
}

/**
 * One phase as the instance page sees it, including where its timer stands (F10.12).
 *
 * Three of the four timer fields are the *inputs* to elapsed rather than elapsed itself, so the
 * page can tick the number up locally instead of polling: it adds its own wall-clock delta since
 * load to `elapsed_seconds`, which makes a browser clock offset structurally unable to skew the
 * display. `remaining` is not sent at all — it is `duration_seconds - elapsed_seconds`.
 */
export interface InstancePhaseView {
  id: number;
  key: string;
  name: string;
  ordinal: number;
  duration_value: number | null;
  duration_unit: string | null;
  auto_advance: boolean;
  is_current: boolean;
  /** The duration in one unit, so the client needs no copy of the unit table. Null = no limit. */
  duration_seconds: number | null;
  /** Banked from previous visits — exactly what "Resume" would restore. */
  accrued_seconds: number;
  /** Banked plus the live run, as of this response. Equals `accrued_seconds` unless current. */
  elapsed_seconds: number;
  /** When this visit began. Null for every phase the instance is not in right now. */
  started_at: Date | null;
}

/** One row of the setups list — identity plus enough lifecycle to read it at a glance. */
export interface InstanceSummary {
  id: number;
  name: string;
  blueprint_key: string;
  lifecycle_state: string;
  /** False for a blueprint with no phases: it has no lifecycle to start, stop or show. */
  has_phases: boolean;
  current_phase: { key: string; name: string } | null;
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  started_at: Date | null;
}

export interface InstanceView {
  id: number;
  name: string;
  blueprint: { id: number; key: string; name: string; version: number };
  /** Set when the blueprint has been published past the version this instance holds (F10.6). */
  blueprint_version_behind: boolean;
  area: { id: number; name: string } | null;
  /**
   * Whether this setup is live (F10.13). `not_started` until the user says the real process began,
   * `stopped` when they park it. Nothing the setup derived acts unless this is `running`.
   */
  lifecycle_state: string;
  current_phase: { id: number; key: string; name: string; ordinal: number } | null;
  phase_started_at: Date | null;
  phases: InstancePhaseView[];
  bindings: { slot_key: string; label: string; user_device_id: number; auto_bound: boolean }[];
  params: ResolvedParam[];
  entities: {
    scenes: { id: number; name: string; blueprint_key: string | null; user_modified: boolean }[];
    rules: { id: number; name: string; blueprint_key: string | null; user_modified: boolean }[];
    pipelines: { id: number; name: string; blueprint_key: string | null; user_modified: boolean }[];
  };
}

type FullPhase = FullInstance['blueprint']['phases'][number];

/**
 * The resolution context *as of* one phase — not necessarily the current one.
 *
 * Building a context per phase is what lets the page show the whole lifecycle: each column is
 * resolved by the same shared resolver the automation-worker runs, just with a different phase
 * pinned. That is the only way "what will this be in Mature?" can be answered without the user
 * advancing the instance to find out.
 */
function buildContextForPhase(instance: FullInstance, phase: FullPhase | null): ParamContext {
  return buildParamContext({
    overrides: instance.overrides,
    defaults: instance.blueprint.params,
    currentPhase: phase,
  });
}

function currentPhaseOf(instance: FullInstance): FullPhase | null {
  // Read off `blueprint.phases`, not the `current_phase` relation, because only the former carries
  // targets and notes — the two are the same row.
  return instance.blueprint.phases.find((p) => p.id === instance.current_phase_id) ?? null;
}

function buildContext(instance: FullInstance): ParamContext {
  return buildContextForPhase(instance, currentPhaseOf(instance));
}

class BlueprintInstancesService {
  /**
   * The setups list. Carries enough lifecycle to answer "what is this doing right now" without
   * opening it — state, which phase, and that phase's timer — because a list of names that all
   * look alike cannot tell a running setup from a parked one.
   *
   * Only the *current* phase's timer is included; the whole matrix belongs to the instance page.
   * Starting from the list therefore loads the instance first, since choosing a phase needs them
   * all — one extra read on a deliberate click, rather than every phase of every setup on a list
   * that mostly just gets looked at.
   */
  async list(userId: number): Promise<InstanceSummary[]> {
    const rows = await db.blueprintInstance.findMany({
      where: { user_id: userId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        lifecycle_state: true,
        phase_started_at: true,
        current_phase_id: true,
        current_phase: {
          select: { key: true, name: true, duration_value: true, duration_unit: true },
        },
        phase_state: { select: { phase_key: true, accrued_seconds: true } },
        blueprint: { select: { key: true, _count: { select: { phases: true } } } },
      },
    });

    const now = new Date();
    return rows.map((r) => {
      const accrued =
        r.phase_state.find((s) => s.phase_key === r.current_phase?.key)?.accrued_seconds ?? 0;
      // Only a running setup has a run in flight; a parked one's elapsed is its bank, frozen.
      const startedAt = r.lifecycle_state === 'running' ? r.phase_started_at : null;
      return {
        id: r.id,
        name: r.name,
        blueprint_key: r.blueprint.key,
        lifecycle_state: r.lifecycle_state,
        has_phases: r.blueprint._count.phases > 0,
        current_phase: r.current_phase
          ? { key: r.current_phase.key, name: r.current_phase.name }
          : null,
        duration_seconds: phaseDurationSeconds(
          r.current_phase?.duration_value ?? null,
          r.current_phase?.duration_unit ?? null,
        ),
        accrued_seconds: accrued,
        elapsed_seconds: r.current_phase ? phaseElapsedSeconds(accrued, startedAt, now) : 0,
        started_at: startedAt,
      };
    });
  }

  async get(userId: number, instanceId: number): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    const ctx = buildContext(instance);
    const currentPhase = currentPhaseOf(instance);
    const slotLabels = new Map(instance.blueprint.slots.map((s) => [s.key, s.label]));
    // One `now` for the whole response, so two phases can never be resolved against clocks that
    // moved between them.
    const now = new Date();
    const accruedByPhase = new Map(
      instance.phase_state.map((s) => [s.phase_key, s.accrued_seconds]),
    );

    // One context per phase, built once and reused across every param, so the matrix costs
    // O(phases) contexts rather than O(phases × params).
    const contextByPhase = new Map<string, ParamContext>(
      instance.blueprint.phases.map((p) => [p.key, buildContextForPhase(instance, p)]),
    );

    log.debug(
      {
        instanceId: instance.id,
        phase: currentPhase?.key ?? null,
        phaseOverrides: ctx.phaseOverrides,
        overrides: ctx.overrides,
        phaseTargets: ctx.phaseTargets,
        defaults: ctx.defaults,
      },
      'instance view: resolving params across every phase',
    );

    return {
      id: instance.id,
      name: instance.name,
      blueprint: {
        id: instance.blueprint.id,
        key: instance.blueprint.key,
        name: instance.blueprint.name,
        version: instance.blueprint.version,
      },
      blueprint_version_behind: instance.blueprint.version > instance.blueprint_version,
      area: instance.area,
      lifecycle_state: instance.lifecycle_state,
      current_phase: instance.current_phase,
      phase_started_at: instance.phase_started_at,
      phases: instance.blueprint.phases.map((p) => {
        const isCurrent = p.id === instance.current_phase_id;
        // Only the current phase has a run in flight; every other phase's elapsed is its bank.
        const startedAt = isCurrent ? instance.phase_started_at : null;
        const accrued = accruedByPhase.get(p.key) ?? 0;
        return {
          id: p.id,
          key: p.key,
          name: p.name,
          ordinal: p.ordinal,
          duration_value: p.duration_value,
          duration_unit: p.duration_unit,
          auto_advance: p.auto_advance,
          is_current: isCurrent,
          duration_seconds: phaseDurationSeconds(p.duration_value, p.duration_unit),
          accrued_seconds: accrued,
          elapsed_seconds: phaseElapsedSeconds(accrued, startedAt, now),
          started_at: startedAt,
        };
      }),
      bindings: instance.bindings.map((b) => ({
        slot_key: b.slot_key,
        label: slotLabels.get(b.slot_key) ?? b.slot_key,
        user_device_id: b.user_device_id,
        auto_bound: b.auto_bound,
      })),
      params: instance.blueprint.params.map((param) => {
        const globalOverride = instance.overrides.find(
          (o) => o.param_key === param.key && o.phase_key === ALL_PHASES,
        );
        const currentTarget = currentPhase?.targets.find((t) => t.param_key === param.key);
        const here = resolveParamWithSource(param.key, ctx);

        return {
          key: param.key,
          label: param.label,
          unit: param.unit,
          user_tunable: param.user_tunable,
          value: here.value,
          source: here.source,
          default_value: param.default_value,
          phase_value: currentTarget?.value ?? null,
          override_value: globalOverride?.value ?? null,
          phases: instance.blueprint.phases.map((phase) => {
            const resolved = resolveParamWithSource(param.key, contextByPhase.get(phase.key)!);
            return {
              phase_key: phase.key,
              phase_name: phase.name,
              is_current: phase.id === instance.current_phase_id,
              value: resolved.value,
              source: resolved.source,
              phase_target: phase.targets.find((t) => t.param_key === param.key)?.value ?? null,
              phase_override:
                instance.overrides.find(
                  (o) => o.param_key === param.key && o.phase_key === phase.key,
                )?.value ?? null,
            };
          }),
        };
      }),
      entities: {
        scenes: instance.scenes,
        rules: instance.rules,
        pipelines: instance.pipelines,
      },
    };
  }

  // ── Lifecycle (F10.13) ──────────────────────────────────────────────────────────────────
  //
  // A derived setup is built, not started. Starting it is where the user says *when* the process
  // it watches actually began — which phase, and how far into that phase — because binding a board
  // carries none of that. Stopping parks the clock and holds every automation the setup owns.

  /**
   * Start (or resume) the setup.
   *
   * `phaseKey` defaults to where it left off when stopped, and to the first phase otherwise, so
   * the common cases need no argument. `mode`/`requestedSeconds` position the clock inside that
   * phase exactly as they do for a phase change: `reset` from zero, `resume` from the phase's
   * bank, `at` from a named value.
   *
   * **A blueprint need not have phases at all**, and plenty are not time-dependent. Such a setup
   * has no lifecycle to position — but it can still be paused and resumed, because pausing means
   * "hold this setup's automations", which is just as meaningful without a schedule. It simply
   * goes straight back to running, with no phase and no clock.
   */
  async start(
    userId: number,
    instanceId: number,
    phaseKey?: string | null,
    mode: PhaseTimerMode = 'reset',
    requestedSeconds = 0,
  ): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    if (instance.lifecycle_state === 'running') {
      throw badRequest('this setup is already running — change its phase or stop it first');
    }

    if (instance.blueprint.phases.length === 0) {
      // Nothing to choose and nothing to time. Without this branch, pausing a phase-less setup
      // would strand it: stop() accepts it and start() would have had no phase to enter.
      await db.blueprintInstance.update({
        where: { id: instanceId },
        data: { lifecycle_state: 'running', updated_at: new Date() },
      });
      log.info(
        { instanceId, from: instance.lifecycle_state, userId },
        'setup resumed — no phases on this blueprint, so nothing to position',
      );
      return this.get(userId, instanceId);
    }

    // Where to begin: what the user asked for, else where it was parked, else the beginning.
    const target =
      phaseKey ?? instance.current_phase?.key ?? instance.blueprint.phases[0]?.key ?? null;
    const phase = instance.blueprint.phases.find((p) => p.key === target);
    if (!phase) {
      throw badRequest(
        `"${target}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${instance.blueprint.phases.map((p) => p.key).join(', ')})`,
      );
    }
    if (mode === 'at' && (requestedSeconds < 0 || requestedSeconds > MAX_ACCRUED_SECONDS)) {
      throw badRequest(`elapsed_seconds must be between 0 and ${MAX_ACCRUED_SECONDS}`);
    }

    const now = new Date();
    const existing = instance.phase_state.find((s) => s.phase_key === phase.key);
    const entering = accruedOnEnter(mode, existing?.accrued_seconds ?? 0, requestedSeconds);
    // Nothing to bank: a setup that was not running has no run in flight, which is precisely what
    // `phase_started_at === null` means in the stopped and not-started states.
    await db.$transaction(async (tx) => {
      await tx.blueprintInstancePhaseState.upsert({
        where: { instance_id_phase_key: { instance_id: instanceId, phase_key: phase.key } },
        create: { instance_id: instanceId, phase_key: phase.key, accrued_seconds: entering },
        update: { accrued_seconds: entering, updated_at: now },
      });
      await tx.blueprintInstance.update({
        where: { id: instanceId },
        data: {
          lifecycle_state: 'running',
          current_phase_id: phase.id,
          phase_started_at: now,
          updated_at: now,
        },
      });
    });

    log.info(
      { instanceId, from: instance.lifecycle_state, phase: phase.key, mode, entering, userId },
      'setup started — its automations are live from now',
    );
    return this.get(userId, instanceId);
  }

  /**
   * Park the lifecycle. Banks the run in flight, clears `phase_started_at` and **remembers the
   * phase**, so starting again offers to carry on where it left off.
   *
   * Clearing the stamp is what stops the clock everywhere at once: the auto-advance cron's
   * due-check reads it, and so does every elapsed number the instance page draws. Nothing needed a
   * second switch.
   */
  async stop(userId: number, instanceId: number): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    if (instance.lifecycle_state !== 'running') {
      throw badRequest('this setup is not running');
    }

    const now = new Date();
    const from = instance.current_phase;
    const banked =
      from && instance.phase_started_at ? secondsBetween(instance.phase_started_at, now) : 0;

    await db.$transaction(async (tx) => {
      if (from) await this.bankPhase(tx, instanceId, from.key, banked, now);
      await tx.blueprintInstance.update({
        where: { id: instanceId },
        data: { lifecycle_state: 'stopped', phase_started_at: null, updated_at: now },
      });
    });

    log.info(
      { instanceId, phase: from?.key ?? null, banked, userId },
      'setup stopped — every automation it owns is held, emergencies included',
    );
    return this.get(userId, instanceId);
  }

  /**
   * Back to never-started: no phase, no clock, every bank discarded.
   *
   * Deliberately destructive about time and nothing else — bindings, overrides and the derived
   * automations are all untouched, so this is "the process is starting over", not "unmake this
   * setup" (that is DELETE).
   */
  async reset(userId: number, instanceId: number): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    const now = new Date();

    await db.$transaction(async (tx) => {
      await tx.blueprintInstancePhaseState.deleteMany({ where: { instance_id: instanceId } });
      await tx.blueprintInstance.update({
        where: { id: instanceId },
        data: {
          lifecycle_state: 'not_started',
          current_phase_id: null,
          phase_started_at: null,
          updated_at: now,
        },
      });
    });

    log.info(
      { instanceId, from: instance.lifecycle_state, userId },
      'setup reset — no phase, no clock, banks discarded; bindings and tuning kept',
    );
    return this.get(userId, instanceId);
  }

  /**
   * Move the setup to another phase by hand — the manual counterpart to the auto-advance cron.
   *
   * Writes the two phase columns and the phase's own time-bank row, and nothing else. Every rule,
   * scene and pipeline reference retunes at the next evaluation without a single automation row
   * being touched, which is exactly what makes this safe to do at any time.
   *
   * `mode` decides what the phase being *entered* starts from — `reset` from zero, `resume` from
   * the bank it left behind last visit, `at` from a value the user named. The phase being *left*
   * banks its run regardless: the two are orthogonal, which is why rolling back and then forward
   * again needs no special-casing of direction.
   */
  async setPhase(
    userId: number,
    instanceId: number,
    phaseKey: string,
    mode: PhaseTimerMode = 'reset',
    requestedSeconds = 0,
  ): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    // Moving between phases is something a *running* setup does. A parked one is started (which
    // takes the same phase and position arguments), so there is no second way in.
    if (instance.lifecycle_state !== 'running') {
      throw badRequest('this setup is not running — start it to choose a phase');
    }
    const phase = instance.blueprint.phases.find((p) => p.key === phaseKey);
    if (!phase) {
      throw badRequest(
        `"${phaseKey}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${instance.blueprint.phases.map((p) => p.key).join(', ')})`,
      );
    }
    if (mode === 'at' && (requestedSeconds < 0 || requestedSeconds > MAX_ACCRUED_SECONDS)) {
      throw badRequest(`elapsed_seconds must be between 0 and ${MAX_ACCRUED_SECONDS}`);
    }
    const from = instance.current_phase;
    // Restarting or repositioning the phase you are already in is a real act; resuming it is not
    // — there is no earlier visit to resume, only the one still running.
    if (mode === 'resume' && from?.key === phase.key) {
      throw badRequest(`already in "${phase.key}" — use reset or at to move its timer`);
    }

    const now = new Date();
    const banked =
      from && instance.phase_started_at ? secondsBetween(instance.phase_started_at, now) : 0;
    const existing = instance.phase_state.find((s) => s.phase_key === phase.key);
    // Re-entering the phase being left: its bank has just grown by this run, and `resume` must see
    // that, not the stale row.
    const bankOfTarget = (existing?.accrued_seconds ?? 0) + (from?.key === phase.key ? banked : 0);
    const entering = accruedOnEnter(mode, bankOfTarget, requestedSeconds);

    await db.$transaction(async (tx) => {
      if (from) {
        await this.bankPhase(tx, instanceId, from.key, banked, now);
      }
      await tx.blueprintInstancePhaseState.upsert({
        where: { instance_id_phase_key: { instance_id: instanceId, phase_key: phase.key } },
        create: { instance_id: instanceId, phase_key: phase.key, accrued_seconds: entering },
        update: { accrued_seconds: entering, updated_at: now },
      });
      await tx.blueprintInstance.update({
        where: { id: instanceId },
        data: { current_phase_id: phase.id, phase_started_at: now, updated_at: now },
      });
    });

    log.info(
      { instanceId, from: from?.key ?? null, to: phase.key, mode, banked, entering, userId },
      'phase set manually — phase columns + time bank written, no automation rows touched',
    );
    return this.get(userId, instanceId);
  }

  /** Credit the phase being left with the run that just ended. Never called with a negative. */
  private async bankPhase(
    tx: Prisma.TransactionClient,
    instanceId: number,
    phaseKey: string,
    seconds: number,
    now: Date,
  ): Promise<void> {
    await tx.blueprintInstancePhaseState.upsert({
      where: { instance_id_phase_key: { instance_id: instanceId, phase_key: phaseKey } },
      create: {
        instance_id: instanceId,
        phase_key: phaseKey,
        accrued_seconds: Math.min(seconds, MAX_ACCRUED_SECONDS),
        last_exited_at: now,
      },
      update: { accrued_seconds: { increment: seconds }, last_exited_at: now, updated_at: now },
    });
  }

  /**
   * The user's own tuning. An override is its **own row** on the **instance**, never an edit of the
   * derived rule and never a write to the blueprint, so a later reconcile cannot clobber it,
   * clearing it restores the blueprint's intent exactly, and two instances of the same blueprint
   * tune independently.
   *
   * `phaseKey` picks the scope: null (or `ALL_PHASES`) sets the value for every phase, a phase key
   * sets it for that phase alone and leaves the rest on the blueprint's schedule. Passing a null
   * `value` deletes precisely that one row and no other — clearing a phase's value must not also
   * wipe the all-phases one.
   */
  async setOverride(
    userId: number,
    instanceId: number,
    paramKey: string,
    value: string | null,
    phaseKey: string | null = null,
  ): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    const param = instance.blueprint.params.find((p) => p.key === paramKey);
    if (!param) throw badRequest(`"${paramKey}" is not a parameter of this blueprint`);
    if (!param.user_tunable) {
      throw badRequest(`"${paramKey}" is phase-driven and cannot be overridden`);
    }

    const scope = phaseKey ?? ALL_PHASES;
    if (scope !== ALL_PHASES && !instance.blueprint.phases.some((p) => p.key === scope)) {
      throw badRequest(
        `"${scope}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${instance.blueprint.phases.map((p) => p.key).join(', ')})`,
      );
    }

    const where = { instance_id: instanceId, param_key: paramKey, phase_key: scope };
    const scopeLabel = scope === ALL_PHASES ? 'every phase' : `phase "${scope}"`;

    if (value === null) {
      await db.blueprintParamOverride.deleteMany({ where });
      log.info(
        { instanceId, paramKey, scope, userId },
        `override cleared for ${scopeLabel} — the layer beneath applies again`,
      );
    } else {
      if (typeof value !== 'string' || !value.trim()) throw badRequest('value is required');
      await db.blueprintParamOverride.upsert({
        where: {
          instance_id_param_key_phase_key: {
            instance_id: instanceId,
            param_key: paramKey,
            phase_key: scope,
          },
        },
        create: { ...where, value: value.trim() },
        update: { value: value.trim() },
      });
      log.info(
        { instanceId, paramKey, scope, value: value.trim(), userId },
        `override set for ${scopeLabel} — its own instance row, so reconcile can never clobber it`,
      );
    }
    return this.get(userId, instanceId);
  }

  private async load(userId: number, instanceId: number): Promise<FullInstance> {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      include: instanceInclude,
    });
    if (!instance) throw notFound();
    if (instance.user_id !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return instance;
  }
}

export const blueprintInstancesService = new BlueprintInstancesService();
