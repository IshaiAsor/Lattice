// OTel first
import { startOtel } from '@lattice/otel';
startOtel('pipeline-worker');

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../../../.env') });
import { createLogger } from '@lattice/logger';
import { connectQueue, consume, publish, QUEUES, RK } from '@lattice/queue';
import type { PipelineTriggerPayload, ActionDispatchPayload } from '@lattice/queue';
import { db } from '@lattice/prisma-client';
import type { PipelineStage, MlModel } from '@lattice/prisma-client';
import { valkey, keys } from '../shared/valkey';
import { emitPipelineResult } from '../shared/socket.emitter';

const log = createLogger('pipeline-worker');
const ML_ROUTER_URL = process.env.ML_ROUTER_URL ?? 'http://localhost:3002';

// ─── ML-router client ─────────────────────────────────────────────────────────

async function mlInfer(kind: string, name: string, version: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${ML_ROUTER_URL}/api/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name, version, input }),
  });
  if (!res.ok) throw new Error(`ml-router ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Stage executors ──────────────────────────────────────────────────────────

type StageWithModel = PipelineStage & { ml_model: MlModel | null };
type StageContext   = { userId: number; runId: number; triggerUserActionId?: number | null };

async function runVlmStage(stage: StageWithModel, ctx: StageContext, _prevOutput: unknown): Promise<unknown> {
  if (!stage.ml_model) throw new Error('vlm stage missing ml_model');

  // Get camera frame from Valkey — find the triggering device's frame
  let image: string | null = null;
  if (ctx.triggerUserActionId) {
    const ua = await db.userAction.findUnique({
      where: { id: ctx.triggerUserActionId },
      select: { user_device_id: true },
    });
    if (ua) image = await valkey.get(keys.cameraFrame(ua.user_device_id));
  }

  if (!image) throw new Error('vlm stage: no camera frame available');

  // Vision model only processes the image — it returns visual observations.
  // Current + historical sensor data are fetched in the sensor_digest stage
  // and combined with these observations before being passed to the LLM stage.
  return mlInfer(stage.ml_model.kind, stage.ml_model.name, stage.ml_model.version, { image });
}

async function runSensorDigestStage(stage: StageWithModel, ctx: StageContext, prevOutput: unknown): Promise<unknown> {
  const config = stage.config as Record<string, unknown> | null ?? {};
  const capabilities  = (config.context_capabilities as string[]) ?? [];
  const windowMin     = (config.window_min as number) ?? 60;
  const cutoff        = new Date(Date.now() - windowMin * 60_000);

  if (!capabilities.length) return { sensors: [] };

  // Resolve all UserActions with these capabilities for this user's pipeline
  const pipeline = await db.pipeline.findUnique({ where: { id: stage.pipeline_id }, select: { user_id: true } });
  if (!pipeline) return { sensors: [] };

  const actions = await db.userAction.findMany({
    where: { user_device: { user_id: pipeline.user_id }, action_def: { capability: { in: capabilities } } },
    include: { action_def: true },
  });

  const sensors: Record<string, string[]> = {};
  for (const action of actions) {
    const readings = await db.sensorReading.findMany({
      where: { user_action_id: action.id, recorded_at: { gte: cutoff } },
      orderBy: { recorded_at: 'desc' },
      take: 50,
      select: { value: true },
    });
    sensors[action.action_def.capability] = readings.map((r) => r.value);
  }

  return {
    sensors,
    // Only include vlm_detections if a vlm stage ran before this one
    ...(prevOutput != null ? { vlm_detections: prevOutput } : {}),
  };
}

async function runLlmStage(stage: StageWithModel, ctx: StageContext, prevOutput: unknown): Promise<unknown> {
  if (!stage.ml_model) throw new Error('llm stage missing ml_model');

  // Attach the camera frame (if available) so vision-capable LLMs (e.g. qwen2.5vl)
  // can see the raw image alongside the YOLO detections + sensor context.
  let image: string | null = null;
  if (ctx.triggerUserActionId) {
    const ua = await db.userAction.findUnique({
      where: { id: ctx.triggerUserActionId },
      select: { user_device_id: true },
    });
    if (ua) image = await valkey.get(keys.cameraFrame(ua.user_device_id));
  }

  const input = {
    ...(prevOutput as Record<string, unknown>),
    ...(image ? { image } : {}),
  };

  return mlInfer(stage.ml_model.kind, stage.ml_model.name, stage.ml_model.version, input);
}

async function runCommandExecStage(stage: StageWithModel, ctx: StageContext, prevOutput: unknown): Promise<unknown> {
  const config     = stage.config as Record<string, unknown> | null ?? {};
  const vocabulary = (config.vocabulary as Record<string, { mqttType: string; mqttName: string; value: string }>) ?? {};
  const output     = prevOutput as Record<string, unknown>;
  const decision   = String(output?.decision ?? '');

  const command = vocabulary[decision];
  if (!command) {
    log.warn({ decision, pipelineStageId: stage.id }, 'command_exec: no vocabulary entry for decision');
    return { decision, dispatched: false };
  }

  // Find the target device — use trigger device or first device of user
  const pipeline = await db.pipeline.findUnique({ where: { id: stage.pipeline_id }, select: { user_id: true } });
  if (!pipeline) return { decision, dispatched: false };

  let userDeviceId = 0;
  if (ctx.triggerUserActionId) {
    const ua = await db.userAction.findUnique({ where: { id: ctx.triggerUserActionId }, select: { user_device_id: true } });
    userDeviceId = ua?.user_device_id ?? 0;
  }

  await publish<ActionDispatchPayload>(RK.actionDispatch(pipeline.user_id), {
    userId: pipeline.user_id,
    userDeviceId,
    mqttType: command.mqttType,
    mqttName: command.mqttName,
    value:    command.value,
  });

  return { decision, dispatched: true, command };
}

// ─── Pipeline executor ────────────────────────────────────────────────────────

async function executePipeline(payload: PipelineTriggerPayload): Promise<void> {
  const { userId, pipelineId, triggerUserActionId, traceId } = payload;

  const pipeline = await db.pipeline.findFirstOrThrow({
    where: { id: pipelineId },
    include: { stages: { include: { ml_model: true }, orderBy: { position: 'asc' } } },
  });

  const run = await db.pipelineRun.create({
    data: { pipeline_id: pipelineId, trigger_user_action_id: triggerUserActionId ?? null, trace_id: traceId ?? null, status: 'running' },
  });

  const ctx: StageContext = { userId, runId: run.id, triggerUserActionId };
  let prevOutput: unknown = null;
  let finalStatus: 'completed' | 'failed' = 'completed';

  for (const stage of pipeline.stages as StageWithModel[]) {
    const startAt = Date.now();
    let stageOutput: unknown = null;
    let stageError: string | undefined;

    try {
      switch (stage.stage_kind) {
        case 'vlm':           stageOutput = await runVlmStage(stage, ctx, prevOutput);          break;
        case 'sensor_digest': stageOutput = await runSensorDigestStage(stage, ctx, prevOutput); break;
        case 'llm':           stageOutput = await runLlmStage(stage, ctx, prevOutput);          break;
        case 'command_exec':  stageOutput = await runCommandExecStage(stage, ctx, prevOutput);  break;
        default:              throw new Error(`Unknown stage kind: ${stage.stage_kind}`);
      }
      prevOutput = stageOutput;
    } catch (err) {
      stageError  = err instanceof Error ? err.message : String(err);
      finalStatus = 'failed';
      log.error({ stageId: stage.id, stage_kind: stage.stage_kind, err }, 'pipeline stage failed');
    }

    await db.pipelineRunStage.create({
      data: {
        pipeline_run_id: run.id,
        position:        stage.position,
        stage_kind:      stage.stage_kind,
        component:       stage.ml_model?.name ?? stage.stage_kind,
        version:         stage.ml_model?.version ?? stage.component_version ?? null,
        input:           prevOutput as any,
        output:          stageOutput as any ?? (stageError ? { error: stageError } : null),
        duration_ms:     Date.now() - startAt,
      },
    });

    if (finalStatus === 'failed') break;
  }

  const finalOutput = finalStatus === 'completed' ? prevOutput : null;

  await db.pipelineRun.update({
    where: { id: run.id },
    data: { status: finalStatus, output: finalOutput as any, finished_at: new Date() },
  });

  // Notify automation-worker + Angular
  await publish(RK.pipelineResult(userId), {
    userId,
    pipelineId,
    runId: run.id,
    status: finalStatus,
    output: finalOutput,
    traceId,
  });

  emitPipelineResult(userId, { pipelineId, runId: run.id, status: finalStatus, output: finalOutput });

  log.info({ pipelineId, runId: run.id, status: finalStatus }, 'pipeline run complete');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await connectQueue();

  await consume<PipelineTriggerPayload>(
    QUEUES.pipelineTrigger,
    async (payload, _headers, ack, nack) => {
      try {
        await executePipeline(payload);
        ack();
      } catch (err) {
        log.error(err, 'pipeline execution failed');
        nack(false);
      }
    },
    /* prefetch */ 1,  // pipelines are heavy — process one at a time per instance
  );

  log.info('pipeline-worker started');
}

start().catch((err) => {
  log.error(err, 'pipeline-worker failed to start');
  process.exit(1);
});
