import { db, Prisma } from '../db';
import {
  resolveParamWithSource,
  buildParamContext,
  ALL_PHASES,
  type ParamContext,
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

export interface InstanceView {
  id: number;
  name: string;
  blueprint: { id: number; key: string; name: string; version: number };
  /** Set when the blueprint has been published past the version this instance holds (F10.6). */
  blueprint_version_behind: boolean;
  area: { id: number; name: string } | null;
  current_phase: { id: number; key: string; name: string; ordinal: number } | null;
  phase_started_at: Date | null;
  phases: {
    id: number;
    key: string;
    name: string;
    ordinal: number;
    duration_value: number | null;
    duration_unit: string | null;
    auto_advance: boolean;
    is_current: boolean;
  }[];
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
  async list(userId: number): Promise<{ id: number; name: string; blueprint_key: string }[]> {
    const rows = await db.blueprintInstance.findMany({
      where: { user_id: userId },
      orderBy: { id: 'asc' },
      select: { id: true, name: true, blueprint: { select: { key: true } } },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, blueprint_key: r.blueprint.key }));
  }

  async get(userId: number, instanceId: number): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    const ctx = buildContext(instance);
    const currentPhase = currentPhaseOf(instance);
    const slotLabels = new Map(instance.blueprint.slots.map((s) => [s.key, s.label]));

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
      current_phase: instance.current_phase,
      phase_started_at: instance.phase_started_at,
      phases: instance.blueprint.phases.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        ordinal: p.ordinal,
        duration_value: p.duration_value,
        duration_unit: p.duration_unit,
        auto_advance: p.auto_advance,
        is_current: p.id === instance.current_phase_id,
      })),
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

  /**
   * Move the setup to another phase by hand — the manual counterpart to the auto-advance cron.
   *
   * Writes `current_phase_id` and re-stamps `phase_started_at`, and nothing else. Every rule,
   * scene and pipeline reference retunes at the next evaluation without a single automation row
   * being touched, which is exactly what makes this safe to do at any time.
   */
  async setPhase(userId: number, instanceId: number, phaseKey: string): Promise<InstanceView> {
    const instance = await this.load(userId, instanceId);
    const phase = instance.blueprint.phases.find((p) => p.key === phaseKey);
    if (!phase) {
      throw badRequest(
        `"${phaseKey}" is not a phase of blueprint "${instance.blueprint.key}" (has: ${instance.blueprint.phases.map((p) => p.key).join(', ')})`,
      );
    }
    await db.blueprintInstance.update({
      where: { id: instanceId },
      data: { current_phase_id: phase.id, phase_started_at: new Date(), updated_at: new Date() },
    });
    log.info(
      { instanceId, from: instance.current_phase?.key ?? null, to: phase.key, userId },
      'phase set manually — one column written, no automation rows touched',
    );
    return this.get(userId, instanceId);
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
