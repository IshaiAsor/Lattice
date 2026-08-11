import { db, Prisma } from '../db';
import {
  resolveParamWithSource,
  buildParamContext,
  accruedOnEnter,
  isParamRef,
  phaseDurationSeconds,
  phaseElapsedSeconds,
  resolvePhaseDuration,
  secondsBetween,
  ALL_PHASES,
  MAX_ACCRUED_SECONDS,
  effectiveLifecycle,
  type ParamContext,
  type ParamSource,
  type PhaseTimerMode,
} from '@lattice/params';
import { createLogger } from '@lattice/logger';
import { loadParamContext } from './blueprints.param-context';

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
      is_static: true,
      context_notes: true,
      params: { orderBy: { sort_order: 'asc' }, select: paramSelect() },
      // Phases hang off a profile (F11). A setup's own lifecycle follows one profile — the one its
      // current phase belongs to, or the first when it has not started — while the bindings of a
      // profiled slot each follow their own. Every profile is loaded to answer both from one read.
      profiles: {
        orderBy: { sort_order: 'asc' },
        select: {
          key: true,
          label: true,
          phases: { orderBy: { ordinal: 'asc' }, select: phaseSelect() },
        },
      },
      slots: { orderBy: { sort_order: 'asc' }, select: { key: true, label: true, profiled: true } },
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
    advance_mode: true,
    context_notes: true,
    targets: { select: { param_key: true, value: true } },
  } satisfies Prisma.BlueprintPhaseSelect;
}

type FullInstance = Prisma.BlueprintInstanceGetPayload<{ include: typeof instanceInclude }>;
type FullProfile = FullInstance['blueprint']['profiles'][number];

/**
 * The profile a *setup* follows — the one owning its current phase, else the first declared.
 *
 * A setup runs a lifecycle of its own only when no slot is profiled — once its bound devices each
 * have one, the setup has no phase to be in. Falling back to the first profile is what makes a
 * not-yet-started setup show the lifecycle it is about to begin rather than an empty track.
 */
function profileOf(instance: FullInstance): FullProfile | null {
  // Once any slot is profiled, the lifecycle belongs to the bound devices and the setup has none of
  // its own — there is no single answer to "which phase is this setup in" when its devices disagree.
  if (!setupHasOwnLifecycle(instance.blueprint.slots)) return null;
  const byCurrent = instance.blueprint.profiles.find((pr) =>
    pr.phases.some((ph) => ph.id === instance.current_phase_id),
  );
  return byCurrent ?? instance.blueprint.profiles[0] ?? null;
}

/**
 * Whether the *setup* walks a lifecycle, as opposed to its bound devices each walking their own.
 *
 * One rule, read the same way by derive, this page and the setups list, so a setup can never be
 * offered a Start that puts it into a phase only one of its devices should be in.
 */
export function setupHasOwnLifecycle(slots: { profiled: boolean }[]): boolean {
  return !slots.some((s) => s.profiled);
}

/** The phases a setup's own lifecycle walks. Empty for a blueprint that declares no profile. */
function phasesOf(instance: FullInstance): FullProfile['phases'] {
  return profileOf(instance)?.phases ?? [];
}

/**
 * Which layer supplied a resolved value — what the UI renders as "your value" vs "from phase".
 * Re-exported from the resolver rather than restated, so a layer added there (the two per-binding
 * ones in F11.3) cannot be missing here.
 */
export type { ParamSource } from '@lattice/params';

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
  /** The stored text: a literal ("7") or a reference (`@param.seedling.days`) — F11.13. */
  duration_value: string | null;
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

/**
 * One phase as a *track* sees it — enough to draw the whole lifecycle as a bar, and no more.
 *
 * Deliberately thinner than InstancePhaseView: a track has no targets, no notes and no ids to act
 * on, because nothing is changed from a track. Only the current phase carries a live clock; every
 * other `elapsed_seconds` is that phase's bank, which is what makes an already-visited phase
 * distinguishable from one never entered.
 */
export interface PhaseTrackItem {
  key: string;
  name: string;
  ordinal: number;
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  is_current: boolean;
}

/** One bound device's whole lifecycle, for the setups list and the dashboard tile (F11.4). */
export interface DeviceTrack {
  binding_id: number;
  /** Which device this track is of — the join from a track to that device's actions. */
  user_device_id: number;
  label: string;
  profile_label: string | null;
  lifecycle_state: string;
  /** Running only while this device *and* its setup are — what any gate reads. */
  effective_state: string;
  current_phase: { key: string; name: string } | null;
  duration_seconds: number | null;
  elapsed_seconds: number;
  started_at: Date | null;
  phases: PhaseTrackItem[];
}

/** One row of the setups list — identity plus enough lifecycle to read it at a glance. */
export interface InstanceSummary {
  id: number;
  name: string;
  blueprint_key: string;
  lifecycle_state: string;
  /**
   * False when the setup itself has no lifecycle — a blueprint with no phases, or one whose bound
   * devices each run their own (F11). Either way there is nothing to start, stop or show here.
   */
  has_phases: boolean;
  current_phase: { key: string; name: string } | null;
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  started_at: Date | null;
  /**
   * The bound devices that run a lifecycle of their own, and how many are running (F11.4) — so the
   * list can say "3 devices · 2 running" for a setup whose state is not one thing.
   */
  devices: { total: number; running: number };
  /**
   * The setup's own track, ordinal-ordered. Empty when the devices own the lifecycle, so a caller
   * never has to ask `has_phases` before drawing it.
   */
  phases: PhaseTrackItem[];
  /**
   * One track per profiled binding — the same lifecycle information, one level down. The list card
   * draws a row per entry; the dashboard tile draws a rail per entry. Empty for a setup whose
   * devices carry no lifecycle of their own.
   */
  device_tracks: DeviceTrack[];
  /**
   * Every device bound to this setup, profiled or not — the join a caller needs to tell which of
   * the user's actions belong here. Deliberately not the setup's area: a user can put unrelated
   * devices in an area, so area membership would over-claim, while a binding is exact.
   */
  device_ids: number[];
}

export interface InstanceView {
  id: number;
  name: string;
  blueprint: { id: number; key: string; name: string; version: number };
  /**
   * A static setup: no slot in it has phases, so nothing is scheduled anywhere (F11.8). It still
   * starts and stops — pausing holds its automations — it just has no phase track and no timers.
   */
  is_static: boolean;
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
  /**
   * The lifecycles this blueprint offers (F11) — what a bound device can be put on, and what
   * re-profiling one may choose between. Empty for a blueprint that declares no profile.
   */
  profiles: { key: string; label: string }[];
  /**
   * True when the setup itself walks a lifecycle. False once any slot is profiled: the phases then
   * belong to the individual bound devices, and the setup only starts and stops.
   */
  has_own_lifecycle: boolean;
  bindings: {
    slot_key: string;
    label: string;
    user_device_id: number;
    auto_bound: boolean;
    /** Set when this device runs a lifecycle of its own — the binding page's per-device card. */
    binding_id: number | null;
    profile_key: string | null;
  }[];
  params: ResolvedParam[];
  entities: {
    scenes: { id: number; name: string; blueprint_key: string | null; user_modified: boolean }[];
    rules: { id: number; name: string; blueprint_key: string | null; user_modified: boolean }[];
    pipelines: { id: number; name: string; blueprint_key: string | null; user_modified: boolean }[];
  };
}

type FullPhase = FullProfile['phases'][number];

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
  return phasesOf(instance).find((p) => p.id === instance.current_phase_id) ?? null;
}

function buildContext(instance: FullInstance): ParamContext {
  return buildContextForPhase(instance, currentPhaseOf(instance));
}

// ── Track building (the setups list and the dashboard tile) ────────────────────────────────────
//
// A *track* is a lifecycle drawn rather than edited: every phase, its length, and how much of it
// has been spent. The list needs it for the setup and for each bound device, which is why it is
// built from a narrow select of its own instead of the instance page's full include — that one
// carries targets, notes and the param matrix, none of which a bar can show.

function trackPhaseSelect() {
  return {
    id: true,
    key: true,
    name: true,
    ordinal: true,
    duration_value: true,
    duration_unit: true,
  } satisfies Prisma.BlueprintPhaseSelect;
}
type TrackPhase = Prisma.BlueprintPhaseGetPayload<{ select: ReturnType<typeof trackPhaseSelect> }>;
type TrackProfile = { key: string; label: string; phases: TrackPhase[] };

/**
 * The profile a *setup* follows: the one owning its current phase, else the first declared — the
 * same rule as `profileOf`, over the lighter row the list selects. Falling back to the first is
 * what lets a not-yet-started setup show the track it is about to begin rather than an empty bar.
 */
function setupProfileOf(row: {
  current_phase_id: number | null;
  blueprint: { slots: { profiled: boolean }[]; profiles: TrackProfile[] };
}): TrackProfile | null {
  if (!setupHasOwnLifecycle(row.blueprint.slots)) return null;
  const byCurrent = row.blueprint.profiles.find((pr) =>
    pr.phases.some((ph) => ph.id === row.current_phase_id),
  );
  return byCurrent ?? row.blueprint.profiles[0] ?? null;
}

function buildTrack(
  phases: TrackPhase[],
  opts: {
    currentPhaseId: number | null;
    accruedByPhase: { phase_key: string; accrued_seconds: number }[];
    /** Null unless the owner is running — a parked track's elapsed is its bank, frozen. */
    startedAt: Date | null;
    ctx: ParamContext | null;
    now: Date;
  },
): PhaseTrackItem[] {
  const banked = new Map(opts.accruedByPhase.map((s) => [s.phase_key, s.accrued_seconds]));
  return phases.map((p) => {
    const isCurrent = p.id === opts.currentPhaseId;
    const bank = banked.get(p.key) ?? 0;
    return {
      key: p.key,
      name: p.name,
      ordinal: p.ordinal,
      duration_seconds: phaseDurationSeconds(
        resolvePhaseDuration(p.duration_value, opts.ctx),
        p.duration_unit,
      ),
      accrued_seconds: bank,
      // Only the current phase has a run in flight; every other phase's elapsed is its bank, which
      // is how a phase already visited stays distinguishable from one never entered.
      elapsed_seconds: phaseElapsedSeconds(bank, isCurrent ? opts.startedAt : null, opts.now),
      is_current: isCurrent,
    };
  });
}

class BlueprintInstancesService {
  /**
   * The setups list. Carries enough lifecycle to answer "what is this doing right now" without
   * opening it — state, which phase, and how far through the *whole* track — because a list of
   * names that all look alike cannot tell a running setup from a parked one, and a single current
   * phase cannot tell one that is nearly finished from one that just began.
   *
   * Tracks are drawing material, not editing material: no ids, targets or notes ride along, so
   * choosing a phase still loads the instance first. That is one extra read on a deliberate click,
   * rather than the whole param matrix on a list that mostly just gets looked at.
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
        // Whether the SETUP has a lifecycle of its own: it needs profiles to follow, and no slot
        // may be profiled — once its devices each have one, the setup has none (F11).
        // The profiles' phases come too: they are the track every row and tile draws.
        blueprint: {
          select: {
            key: true,
            slots: { select: { profiled: true } },
            _count: { select: { profiles: true } },
            profiles: {
              orderBy: { sort_order: 'asc' },
              select: {
                key: true,
                label: true,
                phases: { orderBy: { ordinal: 'asc' }, select: trackPhaseSelect() },
              },
            },
          },
        },
        // Every binding, not just the profiled ones: the unprofiled ones carry no lifecycle but
        // still own devices, and `device_ids` has to name all of them. The "3 devices · 2 running"
        // summary and the tracks below still count profiled bindings only, as they always did.
        bindings: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            label: true,
            profile_key: true,
            user_device_id: true,
            lifecycle_state: true,
            phase_started_at: true,
            current_phase_id: true,
            current_phase: { select: { key: true, name: true } },
            phase_state: { select: { phase_key: true, accrued_seconds: true } },
            user_device: { select: { name: true } },
          },
        },
      },
    });

    const now = new Date();
    // A referenced duration (F11.13) needs a context to become a number, and each device resolves
    // it against its own — that is what lets one lifecycle run long on one device and short on
    // another. Loaded only where the track actually holds a reference, so a blueprint of literals
    // costs nothing extra, which is every blueprint written before references existed.
    const setupContexts = new Map<number, ParamContext>();
    const bindingContexts = new Map<number, ParamContext>();
    for (const r of rows) {
      const setupTrack = setupProfileOf(r)?.phases ?? [];
      if (setupTrack.some((p) => isParamRef(p.duration_value ?? ''))) {
        setupContexts.set(r.id, await loadParamContext(r.id, null));
      }
      for (const b of r.bindings) {
        const track = r.blueprint.profiles.find((pr) => pr.key === b.profile_key)?.phases ?? [];
        if (!track.some((p) => isParamRef(p.duration_value ?? ''))) continue;
        bindingContexts.set(b.id, await loadParamContext(r.id, b.id));
      }
    }

    return rows.map((r) => {
      const accrued =
        r.phase_state.find((s) => s.phase_key === r.current_phase?.key)?.accrued_seconds ?? 0;
      // Only a running setup has a run in flight; a parked one's elapsed is its bank, frozen.
      const startedAt = r.lifecycle_state === 'running' ? r.phase_started_at : null;
      const setupCtx = setupContexts.get(r.id) ?? null;
      // Only a profiled binding has a lifecycle of its own; the tracks and the device counts have
      // always meant those, so they keep meaning those now that unprofiled bindings load too.
      const profiled = r.bindings.filter((b) => b.profile_key !== null);
      return {
        id: r.id,
        name: r.name,
        blueprint_key: r.blueprint.key,
        lifecycle_state: r.lifecycle_state,
        has_phases: r.blueprint._count.profiles > 0 && setupHasOwnLifecycle(r.blueprint.slots),
        current_phase: r.current_phase
          ? { key: r.current_phase.key, name: r.current_phase.name }
          : null,
        duration_seconds: phaseDurationSeconds(
          resolvePhaseDuration(r.current_phase?.duration_value ?? null, setupCtx),
          r.current_phase?.duration_unit ?? null,
        ),
        accrued_seconds: accrued,
        elapsed_seconds: r.current_phase ? phaseElapsedSeconds(accrued, startedAt, now) : 0,
        started_at: startedAt,
        // A setup whose devices own the lifecycle has no track of its own to draw — the rows below
        // carry it instead, and drawing both would show the same time twice.
        phases: setupHasOwnLifecycle(r.blueprint.slots)
          ? buildTrack(setupProfileOf(r)?.phases ?? [], {
              currentPhaseId: r.current_phase_id,
              accruedByPhase: r.phase_state,
              startedAt,
              ctx: setupCtx,
              now,
            })
          : [],
        device_tracks: profiled.map((b) => {
          const profile = r.blueprint.profiles.find((pr) => pr.key === b.profile_key) ?? null;
          const ctx = bindingContexts.get(b.id) ?? null;
          const bankedNow =
            b.phase_state.find((s) => s.phase_key === b.current_phase?.key)?.accrued_seconds ?? 0;
          const bindingStartedAt = b.lifecycle_state === 'running' ? b.phase_started_at : null;
          const currentDef = profile?.phases.find((p) => p.key === b.current_phase?.key) ?? null;
          return {
            binding_id: b.id,
            user_device_id: b.user_device_id,
            label: b.label ?? b.user_device.name ?? `device ${b.id}`,
            profile_label: profile?.label ?? null,
            lifecycle_state: b.lifecycle_state,
            effective_state: effectiveLifecycle(b.lifecycle_state, r.lifecycle_state),
            current_phase: b.current_phase
              ? { key: b.current_phase.key, name: b.current_phase.name }
              : null,
            duration_seconds: currentDef
              ? phaseDurationSeconds(
                  resolvePhaseDuration(currentDef.duration_value, ctx),
                  currentDef.duration_unit,
                )
              : null,
            elapsed_seconds: b.current_phase
              ? phaseElapsedSeconds(bankedNow, bindingStartedAt, now)
              : 0,
            started_at: bindingStartedAt,
            phases: buildTrack(profile?.phases ?? [], {
              currentPhaseId: b.current_phase_id,
              accruedByPhase: b.phase_state,
              startedAt: bindingStartedAt,
              ctx,
              now,
            }),
          };
        }),
        devices: {
          total: profiled.length,
          // A device is only really running when its setup is too, which is what the row shows.
          running: profiled.filter(
            (b) => effectiveLifecycle(b.lifecycle_state, r.lifecycle_state) === 'running',
          ).length,
        },
        // Deduped: one device can fill more than one slot of the same setup, and the dashboard
        // must not then count its actions twice.
        device_ids: [...new Set(r.bindings.map((b) => b.user_device_id))],
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
      phasesOf(instance).map((p) => [p.key, buildContextForPhase(instance, p)]),
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
      is_static: instance.blueprint.is_static,
      blueprint_version_behind: instance.blueprint.version > instance.blueprint_version,
      area: instance.area,
      lifecycle_state: instance.lifecycle_state,
      profiles: instance.blueprint.profiles.map((pr) => ({ key: pr.key, label: pr.label })),
      has_own_lifecycle: setupHasOwnLifecycle(instance.blueprint.slots),
      current_phase: instance.current_phase,
      phase_started_at: instance.phase_started_at,
      phases: phasesOf(instance).map((p) => {
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
          // The view keeps a single "advances on its own clock" boolean — that is all the countdown
          // UI needs. A rule/pipeline-driven phase does not count down, so it reads false here.
          auto_advance: p.advance_mode === 'schedule',
          is_current: isCurrent,
          // Resolved against the setup's live context, so the countdown the page draws is the one
          // the advance cron keeps. `@phase.` is refused in a duration at publish precisely because
          // this is read before the phase is entered.
          duration_seconds: phaseDurationSeconds(
            resolvePhaseDuration(p.duration_value, ctx),
            p.duration_unit,
          ),
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
        binding_id: b.profile_key ? b.id : null,
        profile_key: b.profile_key,
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
          phases: phasesOf(instance).map((phase) => {
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

    if (phasesOf(instance).length === 0) {
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
    const target = phaseKey ?? instance.current_phase?.key ?? phasesOf(instance)[0]?.key ?? null;
    const phase = phasesOf(instance).find((p) => p.key === target);
    if (!phase) {
      throw badRequest(
        `"${target}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${phasesOf(
          instance,
        )
          .map((p) => p.key)
          .join(', ')})`,
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
    const phase = phasesOf(instance).find((p) => p.key === phaseKey);
    if (!phase) {
      throw badRequest(
        `"${phaseKey}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${phasesOf(
          instance,
        )
          .map((p) => p.key)
          .join(', ')})`,
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
    // Re-entering the phase being left: its bank has just been credited with this run, and
    // `resume` must see that, not the stale row.
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
    /** An admin may also pin a param the blueprint marked fixed; the owner may not. */
    isAdmin = false,
  ): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    const param = instance.blueprint.params.find((p) => p.key === paramKey);
    if (!param) throw badRequest(`"${paramKey}" is not a parameter of this blueprint`);
    // `user_tunable = false` means "not the owner's dial" — the blueprint drives it through phase
    // targets. It never meant "unchangeable", but it read that way to an admin too, who had no
    // route to a live setup's fixed value except editing the blueprint and republishing it to
    // every setup derived from it. An admin may write one; the owner still may not.
    if (!param.user_tunable && !isAdmin) {
      throw badRequest(`"${paramKey}" is set by the blueprint's phases and is not adjustable here`);
    }

    const scope = phaseKey ?? ALL_PHASES;
    // Checked against every phase the blueprint declares, not just the setup's own lifecycle: on a
    // setup whose bound devices each own the schedule, `phasesOf` is empty, yet a setup-wide row
    // scoped to "fill" is meaningful and IS honoured at read time — it applies to whichever devices
    // are in that phase. Validating against the setup's own phases would reject a row the resolver
    // would happily use.
    const declaredPhases = instance.blueprint.profiles.flatMap((pr) => pr.phases);
    if (scope !== ALL_PHASES && !declaredPhases.some((p) => p.key === scope)) {
      throw badRequest(
        `"${scope}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${[
          ...new Set(declaredPhases.map((p) => p.key)),
        ].join(', ')})`,
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
