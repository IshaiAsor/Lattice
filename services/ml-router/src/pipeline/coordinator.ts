import type { Channel } from 'amqplib';
import { createLogger } from '@lattice/logger';
import { db, Prisma } from '@lattice/prisma-client';
import {
  consume,
  publish,
  RK,
  QUEUES,
  mlStageRK,
  type PipelineTriggerPayload,
  type PipelineCancelPayload,
  type PipelineStagePayload,
  type PipelineStageDonePayload,
  type PipelineResultPayload,
} from '@lattice/queue';
import { loadPipeline } from './registry';
import type { Run } from './types';
import { emitPipelineRunUpdate } from './socket';
import { prepareLlmPrompt } from './prompt';
import { runEnrich } from './stages/enrich';
import { runCommandExec } from './stages/command-exec';
import { registerPictureResultConsumer } from './picture-capture';

const log = createLogger('ml-router:pipeline');

const runs = new Map<number, Run>();

let channel: Channel;

export async function initPipelineCoordinator(ch: Channel): Promise<void> {
  channel = ch;
  await consume<PipelineTriggerPayload>(ch, QUEUES.PIPELINE_TRIGGER, onTrigger);
  await consume<PipelineCancelPayload>(ch, QUEUES.PIPELINE_CANCEL, onCancel);
  await consume<PipelineStageDonePayload>(ch, QUEUES.PIPELINE_STAGE_DONE, onStageDone);
  await registerPictureResultConsumer(ch);
  log.info('pipeline coordinator ready');
}

async function onCancel(c: PipelineCancelPayload): Promise<void> {
  const runId = Number(c.runId);
  log.info({ runId }, 'PIPELINE_CANCEL received');
  if (runs.delete(runId)) {
    log.info({ runId }, 'pipeline run cancelled — coordinator stopped tracking it');
  }
}

async function onTrigger(t: PipelineTriggerPayload): Promise<void> {
  const pipelineId = Number(t.pipelineId);
  const { runId, isDryRun = false, sensorOverrides } = t;
  log.info({ runId, pipelineId, isDryRun }, 'PIPELINE_TRIGGER received');

  // The API marks the run 'cancelled' synchronously before publishing PIPELINE_CANCEL, but
  // message delivery order across queues isn't guaranteed — re-check here so a cancel that
  // beats the trigger message here doesn't get silently overwritten back to 'running'.
  const existing = await db.pipelineRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (existing?.status === 'cancelled') {
    log.info({ runId }, 'pipeline run was cancelled before dispatch — skipping');
    return;
  }

  await db.pipelineRun.update({
    where: { id: runId },
    data: { status: 'running' },
  });

  const plan = await loadPipeline(pipelineId);
  const run: Run = {
    userId: plan.userId,
    pipelineId,
    runId,
    plan,
    index: 0,
    context: {},
    isDryRun,
    sensorOverrides,
  };
  runs.set(runId, run);
  log.info({ runId, pipelineId, stages: plan.stages.length, isDryRun }, 'pipeline run started');
  await advance(run);
}

async function advance(run: Run): Promise<void> {
  while (run.index < run.plan.stages.length) {
    const stage = run.plan.stages[run.index];
    log.info(
      { runId: run.runId, stageId: stage.dbId, stageType: stage.type, index: run.index },
      'advancing to stage',
    );

    if (stage.type === 'enrich') {
      await runEnrich(channel, run, stage);
      run.index++;
      continue;
    }

    if (stage.type === 'command_exec') {
      await runCommandExec(channel, run, stage);
      run.index++;
      continue;
    }

    // infer stage
    if (stage.model.kind === 'llm') {
      await prepareLlmPrompt(run, stage);
    }

    // VLM stage with nothing to look at — enrich already tried a live/override capture and
    // the sensor_history fallback, so if run.context still has no image there's truly none.
    if (stage.model.kind === 'vlm' && !('image' in run.context)) {
      const skippedOutput = {
        skipped: true,
        reason: 'no camera frame available (live capture and history both empty)',
      };
      await db.pipelineRunStage.upsert({
        where: { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
        update: { status: 'skipped', output: skippedOutput, completed_at: new Date() },
        create: {
          run_id: run.runId,
          stage_id: stage.dbId,
          status: 'skipped',
          output: skippedOutput,
          started_at: new Date(),
          completed_at: new Date(),
        },
      });
      log.info({ runId: run.runId, stageId: stage.dbId }, 'VLM stage skipped — no image available');
      run.index++;
      continue;
    }

    // dispatch infer to executor — always write input so the built prompt is persisted
    const stageInput = run.context as Prisma.InputJsonValue;
    await db.pipelineRunStage.upsert({
      where: { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
      update: { status: 'running', started_at: new Date(), input: stageInput },
      create: {
        run_id: run.runId,
        stage_id: stage.dbId,
        status: 'running',
        started_at: new Date(),
        input: stageInput,
      },
    });

    const payload: PipelineStagePayload = {
      userId: String(run.userId),
      deviceId: '',
      pipelineId: String(run.pipelineId),
      pipelineRunId: String(run.runId),
      stageId: String(stage.dbId),
      stageName: `${stage.model.kind}/${stage.model.name}/${stage.model.version}`,
      stageKind: stage.model.kind,
      context: run.context,
    };
    publish(channel, mlStageRK(stage.model.kind, stage.model.name, stage.model.version), payload);
    log.info(
      { runId: run.runId, stageId: stage.dbId, model: stage.model },
      'pipeline stage dispatched',
    );
    return;
  }

  await finish(run, 'completed');
}

async function onStageDone(d: PipelineStageDonePayload): Promise<void> {
  const runId = Number(d.pipelineRunId);
  const run = runs.get(runId);
  log.info({ runId, stageId: d.stageId, status: d.status }, 'PIPELINE_STAGE_DONE received');
  if (!run) {
    log.warn(
      { runId, stageId: d.stageId },
      'PIPELINE_STAGE_DONE for unknown/finished run — dropped',
    );
    return;
  }

  const stageDbId = Number(d.stageId);
  const stageOutput = d.output
    ? d.error
      ? { ...(d.output as Record<string, unknown>), _error: d.error }
      : d.output
    : d.error
      ? { _error: d.error }
      : undefined;
  await db.pipelineRunStage.upsert({
    where: { run_id_stage_id: { run_id: runId, stage_id: stageDbId } },
    update: {
      status: d.status,
      output: stageOutput as Prisma.InputJsonValue | undefined,
      completed_at: new Date(),
    },
    create: {
      run_id: runId,
      stage_id: stageDbId,
      status: d.status,
      output: stageOutput as Prisma.InputJsonValue | undefined,
      completed_at: new Date(),
    },
  });

  if (d.status === 'failed') {
    await finish(run, 'failed', d.error);
    return;
  }

  if (d.output) run.context = { ...run.context, ...d.output };
  run.index++;
  await advance(run);
}

async function finish(run: Run, status: 'completed' | 'failed', error?: string): Promise<void> {
  log.info({ runId: run.runId, status, error }, 'finishing pipeline run');
  runs.delete(run.runId);
  await db.pipelineRun.update({
    where: { id: run.runId },
    data: { status, completed_at: new Date() },
  });
  const result: PipelineResultPayload = {
    userId: String(run.userId),
    pipelineId: String(run.pipelineId),
    pipelineRunId: String(run.runId),
    status,
    error,
  };
  publish(channel, RK.PIPELINE_RESULT, result);
  emitPipelineRunUpdate(run.userId, {
    runId: run.runId,
    pipelineId: run.pipelineId,
    status,
    error,
  });
  log.info({ runId: run.runId, status }, 'pipeline run finished');
}
