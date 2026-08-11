import { db, Prisma } from '../db';
import {
  accruedOnEnter,
  effectiveLifecycle,
  isParamRef,
  phaseDurationSeconds,
  phaseElapsedSeconds,
  resolvePhaseDuration,
  secondsBetween,
  MAX_ACCRUED_SECONDS,
  type ParamContext,
  type PhaseTimerMode,
} from '@lattice/params';
import { createLogger } from '@lattice/logger';
import { loadParamContext } from './blueprints.param-context';

const log = createLogger('api:blueprints-bindings');

// Per-binding lifecycles (F11.1) — one setup holding several devices that are each on their own
// schedule.
//
// A binding of a *profiled* slot follows one BlueprintProfile and walks that profile's phases on
// its own clock, independently of the setup and of every other binding. This module is the exact
// counterpart of the setup-level lifecycle in blueprints.instances.service, one level down, and
// deliberately shares its vocabulary and its timer helpers rather than re-deriving them: leaving a
// phase banks the run, entering one either spends that bank, discards it, or takes a value the user
// names.
//
// The one thing that is genuinely different is the gate. A binding is live only when **both** it
// and its setup are running — a stopped setup holds every binding regardless of what the bindings
// say — which is why `effectiveLifecycle` exists rather than each caller remembering to check
// twice. It lives in @lattice/params beside `isAutomationLive`, so the view this page shows and the
// gate the rule engine applies are literally the same function.

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message = 'Binding not found'): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

const bindingInclude = {
  instance: { select: { id: true, user_id: true, lifecycle_state: true, blueprint_id: true } },
  current_phase: { select: { id: true, key: true, name: true, ordinal: true } },
  phase_state: true,
  overrides: { select: { param_key: true, phase_key: true, value: true } },
  user_device: { select: { id: true, name: true } },
} satisfies Prisma.BlueprintSlotBindingInclude;

type FullBinding = Prisma.BlueprintSlotBindingGetPayload<{ include: typeof bindingInclude }>;

/** One bound device as the setup page sees it: which profile, where in it, and its clock. */
export interface BindingView {
  binding_id: number;
  slot_key: string;
  user_device_id: number;
  label: string;
  profile_key: string | null;
  profile_label: string | null;
  lifecycle_state: string;
  /** Running only when the binding *and* its setup are — what every automation gate reads. */
  effective_state: string;
  current_phase: { key: string; name: string; ordinal: number } | null;
  /**
   * This device's own pinned values (F11.3) — the top of the precedence stack. `phase_key` is ''
   * for "wherever this device goes". Sent so the pot card can show what is pinned to this one
   * device rather than making the user infer it from a resolved number.
   */
  overrides: { param_key: string; phase_key: string; value: string }[];
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  started_at: Date | null;
  /**
   * The whole track, in exactly the shape the setup-level view uses — so the start / phase-change
   * dialogs are the same components rather than near-copies that would drift apart.
   */
  phases: {
    id: number;
    key: string;
    name: string;
    ordinal: number;
    duration_value: string | null;
    duration_unit: string | null;
    auto_advance: boolean;
    is_current: boolean;
    duration_seconds: number | null;
    accrued_seconds: number;
    elapsed_seconds: number;
    started_at: Date | null;
    /** Params this phase sets — what makes them this device's business rather than another's. */
    param_keys: string[];
  }[];
}

class BlueprintBindingsService {
  /** Every binding of a setup that runs a lifecycle of its own, with its clock resolved. */
  async list(userId: number, instanceId: number): Promise<BindingView[]> {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, user_id: true, lifecycle_state: true, blueprint_id: true },
    });
    if (!instance) throw notFound('Setup not found');
    if (instance.user_id !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const bindings = await db.blueprintSlotBinding.findMany({
      where: { instance_id: instanceId, profile_key: { not: null } },
      include: bindingInclude,
      orderBy: { id: 'asc' },
    });
    const profiles = await db.blueprintProfile.findMany({
      where: { blueprint_id: instance.blueprint_id },
      select: {
        key: true,
        label: true,
        phases: { orderBy: { ordinal: 'asc' }, select: phaseSel() },
      },
    });

    const now = new Date();
    // A phase duration may be a reference (F11.13), and each pot resolves it against its own
    // context — that is the whole point: one lifecycle, different lengths. Loaded only for the pots
    // whose track actually holds one, so a blueprint of literals costs no extra query.
    const contexts = await this.durationContexts(bindings, profiles);
    return bindings.map((b) =>
      this.toView(b, profiles, instance.lifecycle_state, now, contexts.get(b.id) ?? null),
    );
  }

  /**
   * Per-binding contexts for resolving referenced phase durations.
   *
   * The API renders the countdown the user reads and the worker decides when the cron fires; they
   * must resolve a duration the same way or the page shows a deadline the clock does not keep.
   */
  private async durationContexts(
    bindings: FullBinding[],
    profiles: { key: string; phases: PhaseSel[] }[],
  ): Promise<Map<number, ParamContext>> {
    const contexts = new Map<number, ParamContext>();
    const referenced = new Set(
      profiles
        .filter((pr) => pr.phases.some((p) => isParamRef(p.duration_value ?? '')))
        .map((pr) => pr.key),
    );
    if (referenced.size === 0) return contexts;
    for (const binding of bindings) {
      if (!binding.profile_key || !referenced.has(binding.profile_key)) continue;
      contexts.set(binding.id, await loadParamContext(binding.instance_id, binding.id));
    }
    return contexts;
  }

  /**
   * The user's own value for one param, **for this device alone** (F11.3 gave the resolver this
   * layer; this is what finally lets someone write to it).
   *
   * It is the top of the precedence stack, so it beats the setup's override, the phase target and
   * the blueprint default — which is what makes "this pot's seedling is 3 days, the others' 5" a
   * one-row change rather than a second lifecycle. `phaseKey` narrows it to one phase; omitted, it
   * applies wherever this device goes.
   *
   * `null` clears it, and the layer beneath applies again.
   */
  async setOverride(
    userId: number,
    bindingId: number,
    paramKey: string,
    value: string | null,
    phaseKey: string | null = null,
    /** An admin may also pin a param the blueprint marked fixed; the owner may not. */
    isAdmin = false,
  ): Promise<BindingView> {
    const binding = await this.load(userId, bindingId);
    const blueprint = await db.blueprint.findUnique({
      where: { id: binding.instance.blueprint_id },
      select: {
        key: true,
        params: { select: { key: true, user_tunable: true } },
        profiles: { select: { key: true, phases: { select: { key: true } } } },
      },
    });
    const param = blueprint?.params.find((p) => p.key === paramKey);
    if (!param) throw badRequest(`"${paramKey}" is not a parameter of this blueprint`);
    // Same rule as the setup level: a fixed param is the blueprint's to drive, so the owner may not
    // pin it — but an admin may, for this one device, without republishing to everyone.
    if (!param.user_tunable && !isAdmin) {
      throw badRequest(`"${paramKey}" is set by the blueprint's phases and is not adjustable here`);
    }

    // '' rather than NULL for "every phase": Postgres treats NULLs as distinct in a unique index,
    // so a null component would admit duplicate rows. Same convention the instance-level table uses.
    const scope = phaseKey ?? '';
    if (scope !== '') {
      // Checked against this binding's OWN profile: phase keys are unique per lifecycle, so a key
      // from another lifecycle would be accepted here and then never match anything at read time.
      const ownPhases =
        blueprint?.profiles.find((pr) => pr.key === binding.profile_key)?.phases ?? [];
      if (!ownPhases.some((p) => p.key === scope)) {
        throw badRequest(
          `"${scope}" is not a phase of lifecycle "${binding.profile_key}" (has: ${ownPhases
            .map((p) => p.key)
            .join(', ')})`,
        );
      }
    }

    const where = { binding_id: bindingId, param_key: paramKey, phase_key: scope };
    if (value === null) {
      await db.blueprintBindingParamOverride.deleteMany({ where });
      log.info({ bindingId, paramKey, scope, userId }, 'binding override cleared');
    } else {
      if (typeof value !== 'string' || !value.trim()) throw badRequest('value is required');
      await db.blueprintBindingParamOverride.upsert({
        where: {
          binding_id_param_key_phase_key: {
            binding_id: bindingId,
            param_key: paramKey,
            phase_key: scope,
          },
        },
        create: { ...where, value: value.trim() },
        update: { value: value.trim() },
      });
      log.info({ bindingId, paramKey, scope, value: value.trim(), userId }, 'binding override set');
    }
    return this.view(userId, bindingId);
  }

  /**
   * Start (or resume) one binding. `phaseKey` defaults to where it was parked, else the first phase of
   * its profile; the timer arguments position the clock inside that phase exactly as they do for
   * the setup-level lifecycle.
   */
  async start(
    userId: number,
    bindingId: number,
    phaseKey?: string | null,
    mode: PhaseTimerMode = 'reset',
    requestedSeconds = 0,
  ): Promise<BindingView> {
    const binding = await this.load(userId, bindingId);
    if (binding.lifecycle_state === 'running') {
      throw badRequest('this binding is already running — change its phase or stop it first');
    }
    const phases = await this.phasesOf(binding);
    const target = phaseKey ?? binding.current_phase?.key ?? phases[0]?.key ?? null;
    const phase = phases.find((p) => p.key === target);
    if (!phase) {
      throw badRequest(
        `"${target}" is not a phase of profile "${binding.profile_key}" (has: ${phases.map((p) => p.key).join(', ')})`,
      );
    }
    if (mode === 'at' && (requestedSeconds < 0 || requestedSeconds > MAX_ACCRUED_SECONDS)) {
      throw badRequest(`elapsed_seconds must be between 0 and ${MAX_ACCRUED_SECONDS}`);
    }

    const now = new Date();
    const existing = binding.phase_state.find((s) => s.phase_key === phase.key);
    const entering = accruedOnEnter(mode, existing?.accrued_seconds ?? 0, requestedSeconds);

    await db.$transaction(async (tx) => {
      await this.bank(tx, bindingId, phase.key, entering, now, 'set');
      await tx.blueprintSlotBinding.update({
        where: { id: bindingId },
        data: { lifecycle_state: 'running', current_phase_id: phase.id, phase_started_at: now },
      });
    });

    log.info(
      { bindingId, bindingLabel: this.labelOf(binding), phase: phase.key, mode, entering, userId },
      'binding started',
    );
    return this.view(userId, bindingId);
  }

  /** Park one binding: banks its run, stops its clock, remembers its phase. */
  async stop(userId: number, bindingId: number): Promise<BindingView> {
    const binding = await this.load(userId, bindingId);
    if (binding.lifecycle_state !== 'running') throw badRequest('this binding is not running');

    const now = new Date();
    const banked = binding.phase_started_at ? secondsBetween(binding.phase_started_at, now) : 0;

    await db.$transaction(async (tx) => {
      if (binding.current_phase) {
        await this.bank(tx, bindingId, binding.current_phase.key, banked, now, 'increment');
      }
      await tx.blueprintSlotBinding.update({
        where: { id: bindingId },
        data: { lifecycle_state: 'stopped', phase_started_at: null },
      });
    });

    log.info({ bindingId, bindingLabel: this.labelOf(binding), banked, userId }, 'binding stopped');
    return this.view(userId, bindingId);
  }

  /**
   * Back to not-started, discarding this binding's banked time. Optionally moves it to another
   * profile — "this device is on a different schedule now", which is the whole point of a
   * per-binding reset as opposed to resetting the setup.
   */
  async reset(userId: number, bindingId: number, profileKey?: string | null): Promise<BindingView> {
    const binding = await this.load(userId, bindingId);

    if (profileKey != null) {
      const profile = await db.blueprintProfile.findFirst({
        where: { blueprint_id: binding.instance.blueprint_id, key: profileKey },
        select: { key: true },
      });
      if (!profile) {
        throw badRequest(`"${profileKey}" is not a profile of this setup's blueprint`);
      }
    }

    const reprofiled = profileKey != null && profileKey !== binding.profile_key;

    await db.$transaction(async (tx) => {
      await tx.blueprintBindingPhaseState.deleteMany({ where: { binding_id: bindingId } });
      // Moving to another lifecycle invalidates any tuning that named a *phase*: phase keys are
      // unique per lifecycle, not per blueprint, so an override the user set for this device's
      // "harvest" would silently start applying to a different lifecycle's phase of the same name.
      // Tuning that applies to every phase (phase_key = '') is about the device, so it survives.
      if (reprofiled) {
        await tx.blueprintBindingParamOverride.deleteMany({
          where: { binding_id: bindingId, phase_key: { not: '' } },
        });
      }
      await tx.blueprintSlotBinding.update({
        where: { id: bindingId },
        data: {
          lifecycle_state: 'not_started',
          current_phase_id: null,
          phase_started_at: null,
          ...(profileKey != null ? { profile_key: profileKey } : {}),
        },
      });
    });

    log.info(
      {
        bindingId,
        bindingLabel: this.labelOf(binding),
        reprofiledAs: profileKey ?? null,
        droppedPhaseTuning: reprofiled,
        userId,
      },
      'binding reset — banked time discarded, device kept',
    );
    return this.view(userId, bindingId);
  }

  /** Move one binding to another phase of its profile — the setup phase change, one level down. */
  async setPhase(
    userId: number,
    bindingId: number,
    phaseKey: string,
    mode: PhaseTimerMode = 'reset',
    requestedSeconds = 0,
  ): Promise<BindingView> {
    const binding = await this.load(userId, bindingId);
    if (binding.lifecycle_state !== 'running') {
      throw badRequest('this binding is not running — start it to choose a phase');
    }
    const phases = await this.phasesOf(binding);
    const phase = phases.find((p) => p.key === phaseKey);
    if (!phase) {
      throw badRequest(
        `"${phaseKey}" is not a phase of profile "${binding.profile_key}" (has: ${phases.map((p) => p.key).join(', ')})`,
      );
    }
    if (mode === 'resume' && binding.current_phase?.key === phase.key) {
      throw badRequest(`already in "${phase.key}" — use reset or at to move its timer`);
    }
    if (mode === 'at' && (requestedSeconds < 0 || requestedSeconds > MAX_ACCRUED_SECONDS)) {
      throw badRequest(`elapsed_seconds must be between 0 and ${MAX_ACCRUED_SECONDS}`);
    }

    const now = new Date();
    const from = binding.current_phase;
    const banked =
      from && binding.phase_started_at ? secondsBetween(binding.phase_started_at, now) : 0;
    const existing = binding.phase_state.find((s) => s.phase_key === phase.key);
    // Re-entering the phase being left: its bank has just been credited with this run.
    const bankOfTarget = (existing?.accrued_seconds ?? 0) + (from?.key === phase.key ? banked : 0);
    const entering = accruedOnEnter(mode, bankOfTarget, requestedSeconds);

    await db.$transaction(async (tx) => {
      if (from) await this.bank(tx, bindingId, from.key, banked, now, 'increment');
      await this.bank(tx, bindingId, phase.key, entering, now, 'set');
      await tx.blueprintSlotBinding.update({
        where: { id: bindingId },
        data: { current_phase_id: phase.id, phase_started_at: now },
      });
    });

    log.info(
      { bindingId, from: from?.key ?? null, to: phase.key, mode, banked, entering, userId },
      'binding phase set — no automation rows touched',
    );
    return this.view(userId, bindingId);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * One upsert serving both directions: `increment` credits a phase being left, `set` seeds the one
   * being entered. Written as one helper because getting these two the wrong way round is exactly
   * how a bank silently doubles.
   */
  private async bank(
    tx: Prisma.TransactionClient,
    bindingId: number,
    phaseKey: string,
    seconds: number,
    now: Date,
    op: 'increment' | 'set',
  ): Promise<void> {
    const capped = Math.min(Math.max(seconds, 0), MAX_ACCRUED_SECONDS);
    await tx.blueprintBindingPhaseState.upsert({
      where: { binding_id_phase_key: { binding_id: bindingId, phase_key: phaseKey } },
      create: {
        binding_id: bindingId,
        phase_key: phaseKey,
        accrued_seconds: capped,
        ...(op === 'increment' ? { last_exited_at: now } : {}),
      },
      update:
        op === 'increment'
          ? { accrued_seconds: { increment: capped }, last_exited_at: now, updated_at: now }
          : { accrued_seconds: capped, updated_at: now },
    });
  }

  private async load(userId: number, bindingId: number): Promise<FullBinding> {
    const binding = await db.blueprintSlotBinding.findUnique({
      where: { id: bindingId },
      include: bindingInclude,
    });
    if (!binding) throw notFound();
    if (binding.instance.user_id !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    if (!binding.profile_key) {
      throw badRequest('this device is shared by the whole setup and has no lifecycle of its own');
    }
    return binding;
  }

  private async phasesOf(binding: FullBinding) {
    const profile = await db.blueprintProfile.findFirst({
      where: { blueprint_id: binding.instance.blueprint_id, key: binding.profile_key! },
      select: { phases: { orderBy: { ordinal: 'asc' }, select: phaseSel() } },
    });
    return profile?.phases ?? [];
  }

  private labelOf(binding: FullBinding): string {
    return binding.label ?? binding.user_device.name ?? `device ${binding.user_device_id}`;
  }

  private async view(userId: number, bindingId: number): Promise<BindingView> {
    const binding = await this.load(userId, bindingId);
    const profiles = await db.blueprintProfile.findMany({
      where: { blueprint_id: binding.instance.blueprint_id },
      select: {
        key: true,
        label: true,
        phases: { orderBy: { ordinal: 'asc' }, select: phaseSel() },
      },
    });
    const contexts = await this.durationContexts([binding], profiles);
    return this.toView(
      binding,
      profiles,
      binding.instance.lifecycle_state,
      new Date(),
      contexts.get(binding.id) ?? null,
    );
  }

  private toView(
    binding: FullBinding,
    profiles: { key: string; label: string; phases: PhaseSel[] }[],
    setupState: string,
    now: Date,
    /** This binding's own context, for a referenced phase duration. Null ⇒ every duration is a literal. */
    ctx: ParamContext | null,
  ): BindingView {
    const profile = profiles.find((pr) => pr.key === binding.profile_key) ?? null;
    const accruedByPhase = new Map(
      binding.phase_state.map((s) => [s.phase_key, s.accrued_seconds]),
    );
    const currentAccrued = binding.current_phase
      ? (accruedByPhase.get(binding.current_phase.key) ?? 0)
      : 0;
    // Only a running binding has a run in flight; a parked one's elapsed is its bank, frozen.
    const startedAt = binding.lifecycle_state === 'running' ? binding.phase_started_at : null;
    const currentDef = profile?.phases.find((p) => p.key === binding.current_phase?.key) ?? null;

    return {
      binding_id: binding.id,
      slot_key: binding.slot_key,
      user_device_id: binding.user_device_id,
      label: this.labelOf(binding),
      profile_key: binding.profile_key,
      profile_label: profile?.label ?? null,
      lifecycle_state: binding.lifecycle_state,
      effective_state: effectiveLifecycle(binding.lifecycle_state, setupState),
      current_phase: binding.current_phase
        ? {
            key: binding.current_phase.key,
            name: binding.current_phase.name,
            ordinal: binding.current_phase.ordinal,
          }
        : null,
      overrides: binding.overrides.map((o) => ({
        param_key: o.param_key,
        phase_key: o.phase_key,
        value: o.value,
      })),
      duration_seconds: currentDef
        ? phaseDurationSeconds(
            resolvePhaseDuration(currentDef.duration_value, ctx),
            currentDef.duration_unit,
          )
        : null,
      accrued_seconds: currentAccrued,
      elapsed_seconds: binding.current_phase
        ? phaseElapsedSeconds(currentAccrued, startedAt, now)
        : 0,
      started_at: startedAt,
      phases: (profile?.phases ?? []).map((p) => {
        const isCurrent = p.id === binding.current_phase_id;
        // Only the current phase has a run in flight; every other phase's elapsed is its bank.
        const phaseStartedAt = isCurrent ? startedAt : null;
        const banked = accruedByPhase.get(p.key) ?? 0;
        return {
          id: p.id,
          key: p.key,
          name: p.name,
          ordinal: p.ordinal,
          // The stored text (a literal or a reference — the builder shows which) beside the number
          // it resolves to for THIS pot, so the page can say "5 days" while another pot says 3.
          duration_value: p.duration_value,
          duration_unit: p.duration_unit,
          auto_advance: p.advance_mode === 'schedule',
          is_current: isCurrent,
          duration_seconds: phaseDurationSeconds(
            resolvePhaseDuration(p.duration_value, ctx),
            p.duration_unit,
          ),
          accrued_seconds: banked,
          elapsed_seconds: phaseElapsedSeconds(banked, phaseStartedAt, now),
          started_at: phaseStartedAt,
          param_keys: p.targets.map((t) => t.param_key),
        };
      }),
    };
  }
}

function phaseSel() {
  return {
    id: true,
    key: true,
    name: true,
    ordinal: true,
    duration_value: true,
    duration_unit: true,
    advance_mode: true,
    // Which params this phase sets. Sent so a pot card can offer the params ITS lifecycle actually
    // uses — without this every pot is offered every other lifecycle's settings too.
    targets: { select: { param_key: true } },
  } satisfies Prisma.BlueprintPhaseSelect;
}
type PhaseSel = Prisma.BlueprintPhaseGetPayload<{ select: ReturnType<typeof phaseSel> }>;

export const blueprintBindingsService = new BlueprintBindingsService();
