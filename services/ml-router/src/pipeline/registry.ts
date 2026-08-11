import { db } from '@lattice/prisma-client';
import {
  buildParamContext,
  effectiveLifecycle,
  phaseDurationSeconds,
  phaseElapsedSeconds,
  EMPTY_PARAM_CONTEXT,
  type ParamContext,
} from '@lattice/params';
import { createLogger } from '@lattice/logger';

const log = createLogger('ml-router:pipeline:registry');

// DeviceCapability.implementation_type value that produces image/camera-frame telemetry
// (mirrors services/api/src/services/pipelines.service.ts and the backoffice pipeline editor).
// sensor_history rows for it are base64 JPEG frames, not numeric readings — the historic
// digest's compression modes are meaningless for it (see stages/enrich.ts buildSensorDigest).
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

// The phase columns resolution needs, at either level. `advance_mode`/`advance_ref_key` are read
// only to decide whether THIS pipeline is what ends the current phase (F11.x) — resolution ignores
// them.
const phaseSelect = {
  key: true,
  name: true,
  context_notes: true,
  advance_mode: true,
  advance_ref_key: true,
  targets: { select: { param_key: true, value: true } },
} as const;

export interface EnrichStagePlan {
  type: 'enrich';
  dbId: number;
}

export interface InferStagePlan {
  type: 'infer';
  dbId: number;
  model: { kind: string; name: string; version: string };
  prompt_template?: string;
}

export interface CommandExecStagePlan {
  type: 'command_exec';
  dbId: number;
  config: { notify: string; execute_condition: string };
}

export type PipelineStagePlan = EnrichStagePlan | InferStagePlan | CommandExecStagePlan;

export interface PipelineSensorPlan {
  dbId: number;
  user_device_action_id: number;
  /**
   * Which device the reading comes from (F11.7).
   *
   * Context used to be keyed `sensors[group_name][action_name]`, so several devices in one sensor
   * group silently overwrote each other and the model saw one of them presented as the whole group.
   * Everything downstream that needs to tell them apart keys off this.
   */
  user_device_id: number;
  /** What to call that device in the context — its binding's label, else the device's own name. */
  device_label: string;
  action_name: string;
  group_name: string;
  compression: string;
  window_minutes: number;
  n: number | null;
  min_value: string | null;
  max_value: string | null;
  description: string;
  inject_as_sensor: boolean;
  inject_as_action: boolean;
  is_image: boolean;
}

/**
 * One bound device of the setup this pipeline belongs to (F11.7) — what the model needs to reason
 * about several devices at once instead of being shown one and told it is the whole setup.
 *
 * `params` is resolved against **this device's own phase**, which is the piece that makes a
 * setup-wide decision possible: each device's expected band comes from its own profile's schedule
 * with no new resolution machinery, because it is the same resolver with a different phase pinned.
 */
export interface PipelineDevicePlan {
  user_device_id: number;
  /** What the user calls it — the binding's label, else the device's own name. */
  label: string;
  binding_id: number | null;
  profile_key: string | null;
  profile_label: string | null;
  lifecycle_state: string | null;
  /** Live only while this device AND its setup are running. */
  effective_state: string | null;
  phase: {
    key: string;
    name: string;
    elapsed_seconds: number;
    duration_seconds: number | null;
  } | null;
  params: ParamContext;
}

/**
 * Set only when this pipeline is what ends its current phase (F11.x) — its owner's current phase has
 * `advance_mode='pipeline'` and names this pipeline's template. The model then gets the option to
 * end the phase; command_exec turns an `advance=true` decision into a BLUEPRINT_PHASE_ADVANCE for
 * exactly this owner. The target phase is NOT here — the phase owns "where", the worker resolves it.
 */
export interface PhaseAdvancePlan {
  instanceId: number;
  /** The one pot to advance, or null to advance the setup — never a fan-out. */
  bindingId: number | null;
  currentPhaseName: string;
  /**
   * This pipeline's template key, carried into the queue message so automation-worker can re-check
   * that the owner's phase still names it as its decider. The gate below runs when the plan is
   * built; the advance lands after a model call, which is ample time for the phase to have moved.
   */
  refKey: string;
}

export interface PipelinePlan {
  pipelineId: number;
  /** What the user calls it — recorded with every command this pipeline issues (F11.12). */
  name: string;
  userId: number;
  stages: PipelineStagePlan[];
  sensors: PipelineSensorPlan[];
  /** Present only when this pipeline is its current phase's decider (see PhaseAdvancePlan). */
  phaseAdvance: PhaseAdvancePlan | null;
  /**
   * The bound devices this pipeline can see, each with its own phase and its own resolved context.
   * Empty for a pipeline that belongs to no setup, and for one whose setup has no profiled slot —
   * in both cases every sensor already resolves against a single shared context.
   */
  devices: PipelineDevicePlan[];
  // Resolution context for a pipeline derived from a blueprint (F10.1b). A pipeline the user
  // built by hand gets EMPTY_PARAM_CONTEXT, where literals pass through and a stray reference
  // fails closed. Loaded once per plan: the prompt and every sensor bound resolve against the
  // same snapshot, so one run cannot straddle a phase advance.
  params: ParamContext;
}

export async function loadPipeline(pipelineId: number): Promise<PipelinePlan> {
  const pipeline = await db.pipeline.findUniqueOrThrow({
    where: { id: pipelineId },
    include: {
      stages: {
        orderBy: { ordinal: 'asc' },
        include: { ml_model: true },
      },
      sensors: {
        include: {
          user_device_action: {
            select: {
              action_name: true,
              user_device_id: true,
              user_device: { select: { name: true } },
              capability: { select: { implementation_type: true } },
            },
          },
        },
      },
      // The pipeline's own binding, when a per_device template produced it (F11.2). Its phase and
      // lifecycle — not the setup's — are what this pipeline resolves and is gated against.
      blueprint_binding: {
        select: {
          id: true,
          lifecycle_state: true,
          overrides: { select: { param_key: true, phase_key: true, value: true } },
          field_values: { select: { field_key: true, value: true } },
          current_phase: { select: phaseSelect },
        },
      },
      blueprint_instance: {
        select: {
          lifecycle_state: true,
          overrides: { select: { param_key: true, phase_key: true, value: true } },
          field_values: { select: { field_key: true, value: true } },
          blueprint: {
            select: {
              params: { select: { key: true, default_value: true } },
              fields: { select: { key: true, default_value: true } },
              profiles: { select: { key: true, label: true } },
            },
          },
          current_phase: { select: phaseSelect },
          // Every bound device of the setup, so a setup-wide pipeline can describe all of them
          // rather than collapsing them into one lossy map (F11.7).
          bindings: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              user_device_id: true,
              label: true,
              profile_key: true,
              lifecycle_state: true,
              phase_started_at: true,
              phase_state: { select: { phase_key: true, accrued_seconds: true } },
              user_device: { select: { name: true } },
              current_phase: {
                select: {
                  key: true,
                  name: true,
                  context_notes: true,
                  duration_value: true,
                  duration_unit: true,
                  targets: { select: { param_key: true, value: true } },
                },
              },
              overrides: { select: { param_key: true, phase_key: true, value: true } },
              field_values: { select: { field_key: true, value: true } },
            },
          },
        },
      },
    },
  });

  const stages: PipelineStagePlan[] = pipeline.stages.map((s) => {
    if (s.kind === 'enrich') {
      return { type: 'enrich', dbId: s.id } satisfies EnrichStagePlan;
    }
    if (s.kind === 'infer') {
      if (!s.ml_model) throw new Error(`infer stage ${s.id} has no ml_model`);
      return {
        type: 'infer',
        dbId: s.id,
        model: { kind: s.ml_model.kind, name: s.ml_model.name, version: s.ml_model.version },
        prompt_template: s.prompt_template ?? undefined,
      } satisfies InferStagePlan;
    }
    // command_exec
    return {
      type: 'command_exec',
      dbId: s.id,
      config: {
        notify: s.notify ?? 'none',
        execute_condition: s.execute_condition ?? 'always',
      },
    } satisfies CommandExecStagePlan;
  });

  // A binding's label wins over the device's own name: it is what the user called this one, and
  // it is what the model should see in the per-device context.
  const labelByDevice = new Map(
    (pipeline.blueprint_instance?.bindings ?? [])
      .filter((b) => b.label)
      .map((b) => [b.user_device_id, b.label!] as const),
  );
  // Labels are what the model reads, and enrich nests a multi-device group's readings under them —
  // so two devices sharing a label silently overwrite each other, which is the exact bug the
  // per-device block exists to fix. Unlabelled bindings fall back to the device's *name*, and two
  // boards of one sealed type carry the same name, so the collision is the common case rather than
  // an edge one. Disambiguate here, once, where the plan is built.
  const labelOf = uniqueLabels(
    pipeline.sensors.map((s) => ({
      deviceId: s.user_device_action.user_device_id,
      label:
        labelByDevice.get(s.user_device_action.user_device_id) ??
        s.user_device_action.user_device.name,
    })),
  );
  const sensors: PipelineSensorPlan[] = pipeline.sensors.map((s) => ({
    dbId: s.id,
    user_device_action_id: s.user_device_action_id,
    user_device_id: s.user_device_action.user_device_id,
    device_label: labelOf.get(s.user_device_action.user_device_id)!,
    action_name: s.user_device_action.action_name,
    group_name: s.group_name,
    compression: s.compression,
    window_minutes: s.window_minutes,
    n: s.n,
    min_value: s.min_value,
    max_value: s.max_value,
    description: s.description,
    inject_as_sensor: s.inject_as_sensor,
    inject_as_action: s.inject_as_action,
    is_image: IMAGE_IMPL_TYPES.has(s.user_device_action.capability.implementation_type),
  }));

  const instance = pipeline.blueprint_instance;
  const ownBinding = pipeline.blueprint_binding;

  // This pipeline decides its current phase's end only when that phase says so and names it. The
  // owner is the binding for a per_device pipeline, the instance for a setup-wide one — the same
  // level its phase columns live at, so the advance moves exactly one pot or the one setup.
  const ownerPhase = ownBinding ? ownBinding.current_phase : (instance?.current_phase ?? null);
  const phaseAdvance: PhaseAdvancePlan | null =
    instance &&
    ownerPhase &&
    ownerPhase.advance_mode === 'pipeline' &&
    ownerPhase.advance_ref_key === pipeline.blueprint_key
      ? {
          instanceId: pipeline.blueprint_instance_id!,
          bindingId: pipeline.blueprint_binding_id,
          currentPhaseName: ownerPhase.name,
          refKey: pipeline.blueprint_key!,
        }
      : null;

  // The context this pipeline itself resolves against. A per_device pipeline reads its own
  // binding's phase and overrides (F11.3); a setup-wide one reads the instance's, unchanged.
  const params = instance
    ? buildParamContext({
        overrides: instance.overrides,
        defaults: instance.blueprint.params,
        currentPhase: ownBinding ? ownBinding.current_phase : instance.current_phase,
        lifecycle: instance.lifecycle_state,
        binding: ownBinding
          ? { overrides: ownBinding.overrides, lifecycle: ownBinding.lifecycle_state }
          : null,
        fields: {
          binding: ownBinding?.field_values ?? [],
          instance: instance.field_values,
          defaults: instance.blueprint.fields,
        },
      })
    : EMPTY_PARAM_CONTEXT;

  // One entry per bound device that runs a lifecycle of its own, each with its own context. Only
  // profiled bindings are described: an unprofiled one adds nothing the shared context does not
  // already say, and listing it would imply a schedule it does not have.
  const now = new Date();
  const profileLabels = new Map(
    (instance?.blueprint.profiles ?? []).map((pr) => [pr.key, pr.label] as const),
  );
  const devices: PipelineDevicePlan[] = (instance?.bindings ?? [])
    .filter((b) => b.profile_key !== null)
    .map((b) => {
      const accrued =
        b.phase_state.find((ps) => ps.phase_key === b.current_phase?.key)?.accrued_seconds ?? 0;
      const startedAt = b.lifecycle_state === 'running' ? b.phase_started_at : null;
      return {
        user_device_id: b.user_device_id,
        label: b.label ?? b.user_device.name,
        binding_id: b.id,
        profile_key: b.profile_key,
        profile_label: b.profile_key ? (profileLabels.get(b.profile_key) ?? null) : null,
        lifecycle_state: b.lifecycle_state,
        effective_state: effectiveLifecycle(b.lifecycle_state, instance?.lifecycle_state),
        phase: b.current_phase
          ? {
              key: b.current_phase.key,
              name: b.current_phase.name,
              elapsed_seconds: phaseElapsedSeconds(accrued, startedAt, now),
              duration_seconds: phaseDurationSeconds(
                b.current_phase.duration_value,
                b.current_phase.duration_unit,
              ),
            }
          : null,
        params: buildParamContext({
          overrides: instance!.overrides,
          defaults: instance!.blueprint.params,
          // Resolved against THIS device's phase — the whole point of the block.
          currentPhase: b.current_phase,
          lifecycle: instance!.lifecycle_state,
          binding: { overrides: b.overrides, lifecycle: b.lifecycle_state },
          fields: {
            binding: b.field_values,
            instance: instance!.field_values,
            defaults: instance!.blueprint.fields,
          },
        }),
      };
    });

  log.debug(
    {
      pipelineId: pipeline.id,
      blueprintInstanceId: pipeline.blueprint_instance_id,
      blueprintBindingId: pipeline.blueprint_binding_id,
      devices: devices.map((d) => `${d.label}@${d.phase?.key ?? 'none'}`),
      phase: params.phase?.key ?? null,
      phaseOverrides: params.phaseOverrides,
      overrides: params.overrides,
      phaseTargets: params.phaseTargets,
      defaults: params.defaults,
      sensorBounds: sensors
        .filter((x) => x.min_value !== null || x.max_value !== null)
        .map((x) => `${x.group_name}.${x.action_name}=[${x.min_value},${x.max_value}]`),
    },
    'pipeline plan loaded with its parameter context',
  );

  return {
    pipelineId: pipeline.id,
    name: pipeline.name,
    userId: pipeline.user_id,
    stages,
    sensors,
    phaseAdvance,
    devices,
    params,
  };
}

/**
 * One label per device, guaranteed distinct. Devices that already differ keep their label exactly;
 * a repeated label gains the device id, so "Socket Board" becomes "Socket Board #41" / "#44" rather
 * than one of them vanishing from the context.
 */
export function uniqueLabels(rows: { deviceId: number; label: string }[]): Map<number, string> {
  const byDevice = new Map<number, string>();
  for (const r of rows) if (!byDevice.has(r.deviceId)) byDevice.set(r.deviceId, r.label);
  const count = new Map<string, number>();
  for (const label of byDevice.values()) count.set(label, (count.get(label) ?? 0) + 1);
  const out = new Map<number, string>();
  for (const [deviceId, label] of byDevice) {
    out.set(deviceId, (count.get(label) ?? 0) > 1 ? `${label} #${deviceId}` : label);
  }
  return out;
}
