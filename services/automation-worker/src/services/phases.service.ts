import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import {
  isParamRef,
  isPhaseDue,
  resolvePhaseDuration,
  secondsBetween,
  type ParamContext,
} from '@lattice/params';
import { db } from '../db/client';
import { resolveAdvanceTarget } from './phases-logic';
import { contextKey, loadParamContext } from './param-context';

const log = createLogger('automation-worker');

// Phase advance (F10.4 / F11.x). A phase ends and its owner steps to the next — driven by the
// duration cron (`schedule`), a rule firing (`rule`), or a pipeline's model (`pipeline`). All three
// converge on ONE banking advance; only the trigger differs. `advanceSetupPhase` /
// `advanceBindingPhase` are that one advance, so the cron below and the rule/pipeline triggers
// cannot bank time differently.
//
// The whole advance is the two phase columns plus the phases' time banks. Every `@phase.x`
// reference in the owner's rules, scenes and pipelines retunes at the next evaluation because those
// rows store the reference, not the value — no automation row is rewritten, so a user's edits and
// any pending reconcile cannot be clobbered by an advance.
//
// On the banks (F10.12) an automated advance takes a deliberately narrow line:
//   - it *credits* the phase it leaves, so a later rollback has something to resume;
//   - it always **resets** the phase it enters. Spending a bank stays an explicit human act; an
//     automated advance must never resurrect time from an earlier visit, which would silently
//     shorten a phase the user never chose to shorten.
//
// The target is the phase's own `advance_to_key` (null ⇒ next by ordinal), resolved the same way
// for every trigger by `resolveAdvanceTarget`, which also makes the advance idempotent: re-entering
// the current phase is a no-op, so a repeat trigger cannot double-bank.

// A rule-triggered advance must confirm, on the same fresh read that performs the move, that the
// owner's current phase still names this exact rule as its decider — the phase may have advanced or
// been re-authored between the rule firing and this call. `mode` is 'rule' (pipeline advances are
// gated in ml-router and arrive unguarded); `refKey` is the deciding template key.
export interface AdvanceGuard {
  mode: string;
  refKey: string;
}

function passesGuard(
  current: { advance_mode: string; advance_ref_key: string | null },
  guard: AdvanceGuard | undefined,
): boolean {
  if (!guard) return true;
  return current.advance_mode === guard.mode && current.advance_ref_key === guard.refKey;
}

const phaseTargetSelect = {
  id: true,
  key: true,
  name: true,
  ordinal: true,
  advance_to_key: true,
  // Read by the `guard` (below): a rule-triggered advance must confirm this phase still names that
  // rule as its decider, on the same fresh read that performs the move.
  advance_mode: true,
  advance_ref_key: true,
  // Only the schedule cron's due-check reads these; the advance itself ignores them.
  duration_value: true,
  duration_unit: true,
  // The phases to advance *within* are the current phase's own profile siblings (F11), never every
  // phase of the blueprint: two profiles may declare the same key, and a blueprint-wide ordinal
  // scan would step an owner into another lifecycle.
  profile: {
    select: { phases: { select: { id: true, key: true, name: true, ordinal: true } } },
  },
} as const;

/**
 * Advance a **setup's** own lifecycle by one phase. Reloads, so it is safe to call from anywhere
 * (the cron, the rule engine, the pipeline-advance consumer). No-ops — returning false — when the
 * setup is not running, has no current phase, or is already at its target. The setup's lifecycle
 * exists only for a blueprint with no profiled slot; once one is profiled the pots own the clock.
 */
export async function advanceSetupPhase(
  ch: Channel,
  instanceId: number,
  source: string,
  guard?: AdvanceGuard,
): Promise<boolean> {
  const instance = await db.blueprintInstance.findUnique({
    where: { id: instanceId },
    select: {
      id: true,
      user_id: true,
      name: true,
      lifecycle_state: true,
      phase_started_at: true,
      area: { select: { id: true, name: true } },
      phase_state: { select: { phase_key: true, accrued_seconds: true } },
      current_phase: { select: phaseTargetSelect },
    },
  });
  if (!instance || instance.lifecycle_state !== 'running') return false;
  const current = instance.current_phase;
  if (!current || !passesGuard(current, guard)) return false;
  const target = resolveAdvanceTarget(
    current.profile.phases,
    current.ordinal,
    current.advance_to_key,
  );
  if (!target) return false;

  const now = new Date();
  const accrued =
    instance.phase_state.find((s) => s.phase_key === current.key)?.accrued_seconds ?? 0;
  const banked = instance.phase_started_at ? secondsBetween(instance.phase_started_at, now) : 0;
  await db.$transaction([
    // Credit the phase being left, so a rollback later has something to resume.
    db.blueprintInstancePhaseState.upsert({
      where: { instance_id_phase_key: { instance_id: instance.id, phase_key: current.key } },
      create: {
        instance_id: instance.id,
        phase_key: current.key,
        accrued_seconds: accrued + banked,
        last_exited_at: now,
      },
      update: { accrued_seconds: { increment: banked }, last_exited_at: now, updated_at: now },
    }),
    // The entered phase always starts from zero — see the note at the top of this file.
    db.blueprintInstancePhaseState.upsert({
      where: { instance_id_phase_key: { instance_id: instance.id, phase_key: target.key } },
      create: { instance_id: instance.id, phase_key: target.key, accrued_seconds: 0 },
      update: { accrued_seconds: 0, updated_at: now },
    }),
    db.blueprintInstance.update({
      where: { id: instance.id },
      data: { current_phase_id: target.id, phase_started_at: now, updated_at: now },
    }),
  ]);

  log.info(
    { instanceId: instance.id, from: current.key, to: target.key, source },
    'setup phase advanced',
  );
  notifyPhaseAdvanced(
    ch,
    instance.user_id,
    instance.name,
    current.name,
    target.name,
    instance.area,
  );
  return true;
}

/**
 * Advance ONE pot's lifecycle by one phase (F11) — the per-binding twin of `advanceSetupPhase`,
 * writing the binding's own phase columns and time bank. A pot advances only while its setup runs
 * too, so both lifecycles are checked. Never fans out: exactly the binding named here moves.
 */
export async function advanceBindingPhase(
  ch: Channel,
  bindingId: number,
  source: string,
  guard?: AdvanceGuard,
): Promise<boolean> {
  const binding = await db.blueprintSlotBinding.findUnique({
    where: { id: bindingId },
    select: {
      id: true,
      label: true,
      lifecycle_state: true,
      phase_started_at: true,
      phase_state: { select: { phase_key: true, accrued_seconds: true } },
      user_device: { select: { name: true } },
      instance: {
        select: {
          id: true,
          user_id: true,
          name: true,
          lifecycle_state: true,
          area: { select: { id: true, name: true } },
        },
      },
      current_phase: { select: phaseTargetSelect },
    },
  });
  if (
    !binding ||
    binding.lifecycle_state !== 'running' ||
    binding.instance.lifecycle_state !== 'running'
  ) {
    return false;
  }
  const current = binding.current_phase;
  if (!current || !passesGuard(current, guard)) return false;
  const target = resolveAdvanceTarget(
    current.profile.phases,
    current.ordinal,
    current.advance_to_key,
  );
  if (!target) return false;

  const now = new Date();
  const accrued =
    binding.phase_state.find((s) => s.phase_key === current.key)?.accrued_seconds ?? 0;
  const banked = binding.phase_started_at ? secondsBetween(binding.phase_started_at, now) : 0;
  await db.$transaction([
    db.blueprintBindingPhaseState.upsert({
      where: { binding_id_phase_key: { binding_id: binding.id, phase_key: current.key } },
      create: {
        binding_id: binding.id,
        phase_key: current.key,
        accrued_seconds: accrued + banked,
        last_exited_at: now,
      },
      update: { accrued_seconds: { increment: banked }, last_exited_at: now, updated_at: now },
    }),
    db.blueprintBindingPhaseState.upsert({
      where: { binding_id_phase_key: { binding_id: binding.id, phase_key: target.key } },
      create: { binding_id: binding.id, phase_key: target.key, accrued_seconds: 0 },
      update: { accrued_seconds: 0, updated_at: now },
    }),
    db.blueprintSlotBinding.update({
      where: { id: binding.id },
      data: { current_phase_id: target.id, phase_started_at: now },
    }),
  ]);

  const bindingName = binding.label ?? binding.user_device.name ?? `device ${binding.id}`;
  log.info(
    { bindingId: binding.id, binding: bindingName, from: current.key, to: target.key, source },
    'pot phase advanced',
  );
  // Named per binding, not per setup: naming only the setup is useless when its other bound
  // devices did not move.
  notifyPhaseAdvanced(
    ch,
    binding.instance.user_id,
    `${binding.instance.name} · ${bindingName}`,
    current.name,
    target.name,
    binding.instance.area,
  );
  return true;
}

// ─── The schedule trigger: the 10s cron ─────────────────────────────────────────────────────────
//
// One tick: advance every due setup, then every due pot. Two scans because the two live at
// different levels — a setup's phase is on the instance, a pot's on its binding — but each just
// finds the due owners and hands off to the shared advance above.

export async function advanceDuePhases(ch: Channel): Promise<number> {
  const setups = await advanceDueSetupPhases(ch);
  const bindings = await advanceDueBindingPhases(ch);
  return setups + bindings;
}

async function advanceDueSetupPhases(ch: Channel): Promise<number> {
  try {
    const candidates = await db.blueprintInstance.findMany({
      // Only phases that end on their clock, on running setups. A parked setup has no
      // `phase_started_at`, so isPhaseDue would refuse it anyway — stating it keeps the scan small.
      where: { lifecycle_state: 'running', current_phase: { advance_mode: 'schedule' } },
      select: {
        id: true,
        phase_started_at: true,
        phase_state: { select: { phase_key: true, accrued_seconds: true } },
        current_phase: { select: phaseTargetSelect },
      },
    });

    // A duration may be a reference (F11.13), so the due-check needs the same context every other
    // reference resolves against. Loaded per candidate, and only for the ones that actually hold a
    // reference — a literal duration costs no query, which is every blueprint written before this.
    const contexts = await loadContextsFor(
      candidates.map((i) => ({ instanceId: i.id, bindingId: null, phase: i.current_phase })),
    );

    let advanced = 0;
    for (const instance of candidates) {
      const ctx = contexts.get(contextKey(instance.id, null)) ?? null;
      if (isDue(instance.current_phase, instance.phase_started_at, instance.phase_state, ctx)) {
        if (await advanceSetupPhase(ch, instance.id, 'schedule')) advanced++;
      }
    }
    return advanced;
  } catch (err) {
    log.error({ err }, 'error advancing blueprint phases');
    return 0;
  }
}

async function advanceDueBindingPhases(ch: Channel): Promise<number> {
  try {
    const candidates = await db.blueprintSlotBinding.findMany({
      // A pot advances only while its setup runs too — a stopped setup holds every one of them.
      where: {
        lifecycle_state: 'running',
        instance: { lifecycle_state: 'running' },
        current_phase: { advance_mode: 'schedule' },
      },
      select: {
        id: true,
        instance_id: true,
        phase_started_at: true,
        phase_state: { select: { phase_key: true, accrued_seconds: true } },
        current_phase: { select: phaseTargetSelect },
      },
    });

    // Each pot resolves its own duration: this is the whole point of a referenced duration — one
    // lifecycle, and the pot whose seedling is shorter says so with an override of its own.
    const contexts = await loadContextsFor(
      candidates.map((b) => ({
        instanceId: b.instance_id,
        bindingId: b.id,
        phase: b.current_phase,
      })),
    );

    let advanced = 0;
    for (const binding of candidates) {
      const ctx = contexts.get(contextKey(binding.instance_id, binding.id)) ?? null;
      if (isDue(binding.current_phase, binding.phase_started_at, binding.phase_state, ctx)) {
        if (await advanceBindingPhase(ch, binding.id, 'schedule')) advanced++;
      }
    }
    return advanced;
  } catch (err) {
    log.error({ err }, 'error advancing binding phases');
    return 0;
  }
}

/**
 * Contexts for the owners whose current phase has a *referenced* duration (F11.13).
 *
 * Only those: a literal duration needs no context, and every blueprint written before references
 * existed has only literals — so this scan costs exactly what it did before unless a blueprint
 * actually uses the feature. Keyed the same way the rule engine keys its contexts, so a setup and
 * one of its pots never share an entry.
 */
async function loadContextsFor(
  owners: {
    instanceId: number;
    bindingId: number | null;
    phase: { duration_value: string | null } | null;
  }[],
): Promise<Map<string, ParamContext>> {
  const contexts = new Map<string, ParamContext>();
  for (const owner of owners) {
    if (!isParamRef(owner.phase?.duration_value ?? '')) continue;
    const key = contextKey(owner.instanceId, owner.bindingId);
    if (contexts.has(key)) continue;
    const ctx = await loadParamContext(owner.instanceId, owner.bindingId);
    if (ctx) contexts.set(key, ctx);
  }
  return contexts;
}

// Shared due-check for both scans. `current` is already filtered to advance_mode='schedule', so the
// only remaining questions are duration, elapsed (bank + live run) and whether there is a target.
function isDue(
  current: {
    key: string;
    ordinal: number;
    duration_value: string | null;
    duration_unit: string | null;
    advance_to_key: string | null;
    profile: { phases: { key: string; ordinal: number }[] };
  } | null,
  phaseStartedAt: Date | null,
  phaseState: { phase_key: string; accrued_seconds: number }[],
  ctx: ParamContext | null,
): boolean {
  if (!current) return false;
  const target = resolveAdvanceTarget(
    current.profile.phases,
    current.ordinal,
    current.advance_to_key,
  );
  const accrued = phaseState.find((s) => s.phase_key === current.key)?.accrued_seconds ?? 0;
  return isPhaseDue({
    is_scheduled: true,
    // Resolved for THIS owner. An unresolvable reference yields null, which reads as "no duration",
    // so the phase holds rather than advancing on a number nobody wrote.
    duration_value: resolvePhaseDuration(current.duration_value, ctx),
    duration_unit: current.duration_unit,
    phase_started_at: phaseStartedAt,
    accrued_seconds: accrued,
    hasNextPhase: target !== null,
  });
}

// Best-effort, same contract as notifyRuleFired: a missing notification-service must not break
// the advance, which has already been committed.
function notifyPhaseAdvanced(
  ch: Channel,
  userId: number,
  instanceName: string,
  from: string,
  to: string,
  area: { id: number; name: string } | null,
): void {
  try {
    publish(ch, RK.NOTIFICATION_SEND, {
      userId: String(userId),
      eventType: 'blueprint_phase_advanced',
      data: { instanceName, fromPhase: from, toPhase: to },
      // Instance-scoped so two setups advancing in the same window don't suppress each other.
      dedupeKey: `blueprint-phase:${instanceName}:${to}`,
      ...(area ? { context: { area_id: area.id, area_name: area.name } } : {}),
    } satisfies NotificationSendPayload);
  } catch (err) {
    log.warn({ err, instanceName }, 'failed to publish phase-advanced notification — skipped');
  }
}
