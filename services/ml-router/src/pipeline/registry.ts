import { db } from '@lattice/prisma-client';

// DeviceCapability.implementation_type value that produces image/camera-frame telemetry
// (mirrors services/api/src/services/pipelines.service.ts and the backoffice pipeline editor).
// sensor_history rows for it are base64 JPEG frames, not numeric readings — the historic
// digest's compression modes are meaningless for it (see stages/enrich.ts buildSensorDigest).
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

export interface EnrichStagePlan {
  type: 'enrich';
  dbId: number;
}

export interface InferStagePlan {
  type: 'infer';
  dbId: number;
  model: { kind: string; name: string; version: string };
  config?: { prompt_template?: string };
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

export interface PipelinePlan {
  pipelineId: number;
  userId: number;
  stages: PipelineStagePlan[];
  sensors: PipelineSensorPlan[];
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
            select: { action_name: true, capability: { select: { implementation_type: true } } },
          },
        },
      },
    },
  });

  const stages: PipelineStagePlan[] = pipeline.stages.map((s) => {
    const cfg = (s.config ?? {}) as Record<string, unknown>;
    if (s.kind === 'enrich') {
      return { type: 'enrich', dbId: s.id } satisfies EnrichStagePlan;
    }
    if (s.kind === 'infer') {
      if (!s.ml_model) throw new Error(`infer stage ${s.id} has no ml_model`);
      return {
        type: 'infer',
        dbId: s.id,
        model: { kind: s.ml_model.kind, name: s.ml_model.name, version: s.ml_model.version },
        config: cfg['prompt_template']
          ? { prompt_template: cfg['prompt_template'] as string }
          : undefined,
      } satisfies InferStagePlan;
    }
    // command_exec
    return {
      type: 'command_exec',
      dbId: s.id,
      config: {
        notify: (cfg['notify'] as string) ?? 'none',
        execute_condition: (cfg['execute_condition'] as string) ?? 'always',
      },
    } satisfies CommandExecStagePlan;
  });

  const sensors: PipelineSensorPlan[] = pipeline.sensors.map((s) => ({
    dbId: s.id,
    user_device_action_id: s.user_device_action_id,
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

  return { pipelineId: pipeline.id, userId: pipeline.user_id, stages, sensors };
}
