import { db, Prisma } from '@lattice/prisma-client';
import { deriveValidParameters } from '@lattice/capability-validation';
import { CreatePipelineDto } from './pipelines.types';
import {
  validate,
  validateStageOrdering,
  ensureActionOwnership,
  err,
} from './pipelines.validation';

// DeviceCapability.implementation_type value that produces image/camera-frame telemetry
// (mirrors pipelines.validation.ts / digest-service/resolve.ts / the backoffice pipeline editor)
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

function windowToMinutes(value: number, unit: string): number {
  if (unit === 'hours') return value * 60;
  if (unit === 'days') return value * 60 * 24;
  return value;
}

// Hoisted so the payload type can be named — an inline include leaks an unnameable
// `.prisma/client/runtime` type into the exported service (TS2742).
const pipelineDetailInclude = {
  stages: { orderBy: { ordinal: 'asc' }, include: { ml_model: true } },
  sensors: {
    orderBy: { id: 'asc' },
    include: {
      user_device_action: {
        select: {
          action_name: true,
          mqtt_action_name: true,
          capability: {
            select: {
              implementation_type: true,
              traits: { select: { google_trait: { select: { valid_parameters: true } } } },
            },
          },
        },
      },
    },
  },
  triggers: true,
} satisfies Prisma.PipelineInclude;

function toPipelineWriteData(dto: CreatePipelineDto) {
  return {
    stages: {
      create: dto.stages.map((s) => ({
        ordinal: s.ordinal,
        kind: s.kind,
        ml_model_id: s.kind === 'infer' ? s.ml_model_id : null,
        prompt_template: s.kind === 'infer' ? (s.prompt_template ?? null) : null,
        notify: s.kind === 'command_exec' ? (s.notify ?? null) : null,
        execute_condition: s.kind === 'command_exec' ? (s.execute_condition ?? null) : null,
      })),
    },
    sensors: {
      create: dto.sensors.map((s) => ({
        group_name: s.group_name.trim(),
        description: s.description.trim(),
        user_device_action_id: s.user_device_action_id,
        inject_as_sensor: s.inject_as_sensor,
        inject_as_action: s.inject_as_action,
        min_value: s.min_value ?? null,
        max_value: s.max_value ?? null,
        compression: s.compression,
        window_minutes: windowToMinutes(s.window_value, s.window_unit),
        n: s.n ?? null,
      })),
    },
    triggers: {
      create: dto.triggers.map((t) => ({
        trigger_type: t.trigger_type,
        user_device_action_id: t.user_device_action_id ?? null,
        operator: t.operator ?? null,
        threshold_value: t.threshold_value ?? null,
        schedule_time: t.schedule_time ?? null,
        schedule_until: t.schedule_until ?? null,
        schedule_every_minutes: t.schedule_every_minutes ?? null,
        schedule_days: t.schedule_days ?? [],
        min_interval_sec: t.min_interval_sec ?? null,
      })),
    },
  };
}

async function ensureOwnedActions(userId: number, dto: CreatePipelineDto): Promise<void> {
  const actionIds = [
    ...dto.sensors.map((s) => s.user_device_action_id),
    ...dto.triggers.filter((t) => t.user_device_action_id).map((t) => t.user_device_action_id!),
  ];
  await ensureActionOwnership(userId, actionIds);
  await validateStageOrdering(dto);
}

class PipelinesService {
  async list(userId: number) {
    const pipelines = await db.pipeline.findMany({
      where: { user_id: userId },
      orderBy: { id: 'asc' },
      include: {
        stages: { orderBy: { ordinal: 'asc' } },
        triggers: true,
        runs: {
          orderBy: { started_at: 'desc' },
          take: 1,
          select: { status: true, started_at: true, is_dry_run: true },
        },
      },
    });
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      stage_count: p.stages.length,
      trigger_types: [...new Set(p.triggers.map((t) => t.trigger_type))],
      last_run: p.runs[0] ?? null,
    }));
  }

  async get(userId: number, id: number) {
    const p = await db.pipeline.findUnique({
      where: { id },
      include: pipelineDetailInclude,
    });
    if (!p) throw err(404, 'Pipeline not found');
    if (p.user_id !== userId) throw err(403, 'Forbidden');

    // is_image/valid_parameters are derived, not stored — resolve them here so the frontend
    // (e.g. the simulate dialog) can render a file uploader vs. a range/enum-constrained
    // input without re-deriving the capability/trait join itself.
    return {
      ...p,
      sensors: p.sensors.map((s) => {
        const implType = s.user_device_action.capability.implementation_type;
        const traits = s.user_device_action.capability.traits;
        return {
          ...s,
          is_image: IMAGE_IMPL_TYPES.has(implType),
          valid_parameters: IMAGE_IMPL_TYPES.has(implType)
            ? undefined
            : deriveValidParameters(traits.map((t) => t.google_trait.valid_parameters)),
        };
      }),
    };
  }

  async create(userId: number, dto: CreatePipelineDto) {
    validate(dto);
    await ensureOwnedActions(userId, dto);

    return db.pipeline.create({
      data: {
        user_id: userId,
        name: dto.name.trim(),
        ...toPipelineWriteData(dto),
      },
      include: {
        stages: { orderBy: { ordinal: 'asc' } },
        sensors: true,
        triggers: true,
      },
    });
  }

  async update(userId: number, id: number, dto: CreatePipelineDto) {
    validate(dto);
    const existing = await db.pipeline.findUnique({
      where: { id },
      select: { user_id: true, blueprint_instance_id: true },
    });
    if (!existing) throw err(404, 'Pipeline not found');
    if (existing.user_id !== userId) throw err(403, 'Forbidden');
    // See rules.service.update — editing a derived pipeline is drift (F10.6).
    const userModified = existing.blueprint_instance_id !== null ? true : undefined;
    await ensureOwnedActions(userId, dto);

    return db.$transaction(async (tx) => {
      await tx.pipelineStage.deleteMany({ where: { pipeline_id: id } });
      await tx.pipelineSensor.deleteMany({ where: { pipeline_id: id } });
      await tx.pipelineTrigger.deleteMany({ where: { pipeline_id: id } });
      return tx.pipeline.update({
        where: { id },
        data: {
          name: dto.name.trim(),
          user_modified: userModified,
          updated_at: new Date(),
          ...toPipelineWriteData(dto),
        },
        include: {
          stages: { orderBy: { ordinal: 'asc' } },
          sensors: true,
          triggers: true,
        },
      });
    });
  }

  async setEnabled(userId: number, id: number, enabled: boolean): Promise<void> {
    const p = await db.pipeline.findUnique({ where: { id }, select: { user_id: true } });
    if (!p) throw err(404, 'Pipeline not found');
    if (p.user_id !== userId) throw err(403, 'Forbidden');
    // Any hand toggle takes ownership of this row's enabled state: reconcile must not later
    // "restore" something the user just set. Clearing the flag on an explicit disable is the
    // point — it is what separates "I turned this off" from "reconcile turned this off".
    await db.pipeline.update({
      where: { id },
      data: { enabled, disabled_by_reconcile: false, updated_at: new Date() },
    });
  }

  async remove(userId: number, id: number): Promise<void> {
    const p = await db.pipeline.findUnique({ where: { id }, select: { user_id: true } });
    if (!p) throw err(404, 'Pipeline not found');
    if (p.user_id !== userId) throw err(403, 'Forbidden');
    await db.pipeline.delete({ where: { id } });
  }

  async listMlModels() {
    return db.mlModel.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }, { version: 'asc' }],
      select: { id: true, kind: true, name: true, version: true, backend: true },
    });
  }
}

export const pipelinesService = new PipelinesService();
