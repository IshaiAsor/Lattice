import { db } from '@lattice/prisma-client';
import { deriveValidParameters, validateValue } from '@lattice/capability-validation';
import { validateSchedule } from '@lattice/params';
import { CreatePipelineDto, InferStageDto } from './pipelines.types';

// DeviceCapability.implementation_type value that produces image/camera-frame telemetry
// (mirrors digest-service/resolve.ts and the backoffice pipeline editor)
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

// Read-only sensor types — cannot receive commands, so they can never be an "available action"
// for the LLM (mirrors the backoffice pipeline editor's SENSOR_IMPL_TYPES).
const SENSOR_IMPL_TYPES = new Set([
  'TemperatureAction',
  'AirTemperatureAction',
  'HumidityAction',
  'WaterLevelAction',
  'PhLevelAction',
  'TdsLevelAction',
  'CO2LevelAction',
]);

export function err(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function validate(dto: CreatePipelineDto): void {
  if (!dto.name?.trim()) throw err(400, 'name is required');
  if (!Array.isArray(dto.stages) || dto.stages.length === 0)
    throw err(400, 'at least one stage is required');
  if (!Array.isArray(dto.sensors) || dto.sensors.length === 0)
    throw err(400, 'at least one sensor is required');
  if (!Array.isArray(dto.triggers) || dto.triggers.length === 0)
    throw err(400, 'at least one trigger is required');

  const ordinals = dto.stages.map((s) => s.ordinal);
  if (new Set(ordinals).size !== ordinals.length) throw err(400, 'stage ordinals must be unique');

  for (const s of dto.stages) {
    if (s.kind === 'infer' && !s.ml_model_id) throw err(400, 'infer stage requires ml_model_id');
  }

  for (const s of dto.sensors) {
    if (!s.description?.trim())
      throw err(400, 'every sensor/action item requires context (description)');
  }

  for (const t of dto.triggers) {
    if (t.trigger_type === 'sensor_threshold') {
      if (!t.user_device_action_id || !t.operator || t.threshold_value == null) {
        throw err(
          400,
          'sensor_threshold trigger requires user_device_action_id, operator, threshold_value',
        );
      }
    }
    if (t.trigger_type === 'schedule') {
      // The same rules a rule condition and a blueprint template are held to — one validator, so a
      // schedule that saves on one surface cannot be rejected on another.
      const problem = validateSchedule({
        time: t.schedule_time ?? null,
        until: t.schedule_until,
        everyMinutes: t.schedule_every_minutes,
        days: t.schedule_days ?? [],
      });
      if (problem) throw err(400, `schedule trigger: ${problem}`);
    }
  }
}

// Pipeline context accumulates stage-by-stage (see ml-router/pipeline/coordinator.ts), so these
// checks only require the prerequisite stage to appear anywhere earlier in ordinal order — not
// immediately before — and must be re-checked here since the frontend can't be trusted alone.
export async function validateStageOrdering(dto: CreatePipelineDto): Promise<void> {
  const modelIds = [
    ...new Set(
      dto.stages.filter((s): s is InferStageDto => s.kind === 'infer').map((s) => s.ml_model_id),
    ),
  ];
  const models = modelIds.length
    ? await db.mlModel.findMany({
        where: { id: { in: modelIds } },
        select: { id: true, kind: true },
      })
    : [];
  const modelKindById = new Map(models.map((m) => [m.id, m.kind]));

  const sensorActionIds = [...new Set(dto.sensors.map((s) => s.user_device_action_id))];
  const sensorActions = sensorActionIds.length
    ? await db.userDeviceAction.findMany({
        where: { id: { in: sensorActionIds } },
        select: { id: true, capability: { select: { implementation_type: true } } },
      })
    : [];
  const implTypeById = new Map(sensorActions.map((a) => [a.id, a.capability.implementation_type]));
  const imageActionIds = sensorActions
    .filter((a) => IMAGE_IMPL_TYPES.has(a.capability.implementation_type))
    .map((a) => a.id);
  const hasImageSensor = imageActionIds.length > 0;

  // The VLM handler only supports a single context.image today — reject a second camera item
  // outright rather than silently picking one and ignoring the rest.
  if (imageActionIds.length > 1) {
    throw err(400, 'only one camera item is supported per pipeline');
  }

  // Telemetry/image items are read-only and always-on for the LLM — the client shouldn't be able
  // to flip these, but re-derive and enforce here rather than trusting it.
  for (const s of dto.sensors) {
    const implType = implTypeById.get(s.user_device_action_id);
    const isForced =
      implType !== undefined && (SENSOR_IMPL_TYPES.has(implType) || IMAGE_IMPL_TYPES.has(implType));
    if (isForced && (!s.inject_as_sensor || s.inject_as_action)) {
      throw err(
        400,
        `telemetry/image item ${s.user_device_action_id} must have inject_as_sensor=true and inject_as_action=false`,
      );
    }
  }

  const ordered = [...dto.stages].sort((a, b) => a.ordinal - b.ordinal);
  let sawEnrich = false;
  let sawLlm = false;
  for (const s of ordered) {
    if (s.kind === 'enrich') sawEnrich = true;
    if (s.kind === 'infer') {
      const modelKind = modelKindById.get(s.ml_model_id);
      if (modelKind === 'llm') {
        if (!sawEnrich) throw err(400, 'llm infer stage must be preceded by an enrich stage');
        sawLlm = true;
      }
      if (modelKind === 'vlm' && !hasImageSensor) {
        throw err(400, 'vlm infer stage requires an image sensor in the sensor list');
      }
    }
    if (s.kind === 'command_exec' && !sawLlm) {
      throw err(400, 'command_exec stage must be preceded by an llm infer stage');
    }
  }
}

// Dry-run sensor overrides are user-typed, so re-derive each action's constraint from its
// capability's traits and reject values the device itself would never accept — a text field
// can't otherwise stop e.g. a temperature override of "9999". Image sensors carry a raw
// base64 frame instead of a scalar reading, so they have no range/enum constraint to check.
export async function validateSensorOverrides(
  sensorActionIds: number[],
  overrides: Record<string, string>,
): Promise<void> {
  if (sensorActionIds.length === 0) return;
  const actions = await db.userDeviceAction.findMany({
    where: { id: { in: sensorActionIds } },
    select: {
      id: true,
      capability: {
        select: {
          implementation_type: true,
          traits: { select: { google_trait: { select: { valid_parameters: true } } } },
        },
      },
    },
  });
  for (const action of actions) {
    const value = overrides[String(action.id)];
    if (value === undefined || value === '') continue;
    if (IMAGE_IMPL_TYPES.has(action.capability.implementation_type)) continue;
    const constraint = deriveValidParameters(
      action.capability.traits.map((t) => t.google_trait.valid_parameters),
    );
    if (constraint && !validateValue(value, constraint)) {
      throw err(
        400,
        `override value '${value}' for sensor action ${action.id} does not satisfy its constraint`,
      );
    }
  }
}

export async function ensureActionOwnership(userId: number, actionIds: number[]): Promise<void> {
  const unique = [...new Set(actionIds)];
  if (unique.length === 0) return;
  const owned = await db.userDeviceAction.findMany({
    where: { id: { in: unique }, user_device: { user_id: userId } },
    select: { id: true },
  });
  if (owned.length !== unique.length)
    throw err(403, 'one or more actions do not belong to this user');
}
