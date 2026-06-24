import type { Channel } from 'amqplib';
import { createLogger } from '@lattice/logger';
import {
  consume,
  publish,
  RK,
  QUEUES,
  mlStageRK,
  type PipelineTriggerPayload,
  type PipelineStagePayload,
  type PipelineStageDonePayload,
  type PipelineResultPayload,
} from '@lattice/queue';
import { loadPipeline, type PipelinePlan } from './registry';

const log = createLogger('ml-router:pipeline');

// In-flight pipeline run state, keyed by pipelineRunId. The coordinator walks the plan:
// `infer` stages are dispatched to the executor and pause the run until PIPELINE_STAGE_DONE;
// `enrich` stages run locally between them.
interface Run {
  userId: string;
  deviceId: string;
  pipelineId: string;
  pipelineRunId: string;
  plan: PipelinePlan;
  index: number;
  context: Record<string, unknown>;
}
const runs = new Map<string, Run>();

let channel: Channel;

export async function initPipelineCoordinator(ch: Channel): Promise<void> {
  channel = ch;
  await consume<PipelineTriggerPayload>(ch, QUEUES.PIPELINE_TRIGGER, onTrigger);
  await consume<PipelineStageDonePayload>(ch, QUEUES.PIPELINE_STAGE_DONE, onStageDone);
  log.info('pipeline coordinator ready (PIPELINE_TRIGGER → stages → PIPELINE_STAGE_DONE → result)');
}

async function onTrigger(t: PipelineTriggerPayload): Promise<void> {
  const plan = loadPipeline(t.pipelineId);
  const pipelineRunId = `run_${t.pipelineId}_${Date.now()}`;
  const run: Run = {
    userId: t.userId,
    deviceId: t.deviceId,
    pipelineId: t.pipelineId,
    pipelineRunId,
    plan,
    index: 0,
    context: { value: t.value, actionName: t.actionName },
  };
  runs.set(pipelineRunId, run);
  log.info({ pipelineRunId, pipelineId: t.pipelineId, stages: plan.stages.length }, 'pipeline run started');
  await advance(run);
}

// Walk stages until an infer stage is dispatched (which pauses the run) or the plan completes.
async function advance(run: Run): Promise<void> {
  while (run.index < run.plan.stages.length) {
    const stage = run.plan.stages[run.index];

    if (stage.type === 'enrich') {
      // TODO: real pipeline enrichment (read sensor/device state into context). Stubbed —
      // pass-through for now, see project_sensor_data_service.
      log.info({ pipelineRunId: run.pipelineRunId, enricher: stage.enricher }, 'enrich stage (stub)');
      run.index++;
      continue;
    }

    // infer stage → dispatch to the executor's per-model stage queue; pause until STAGE_DONE.
    const stageId = `s${run.index}`;
    const payload: PipelineStagePayload = {
      userId: run.userId,
      deviceId: run.deviceId,
      pipelineId: run.pipelineId,
      pipelineRunId: run.pipelineRunId,
      stageId,
      stageName: `${stage.model.kind}/${stage.model.name}/${stage.model.version}`,
      stageKind: stage.model.kind,
      context: run.context,
    };
    publish(channel, mlStageRK(stage.model.kind, stage.model.name, stage.model.version), payload);
    log.info({ pipelineRunId: run.pipelineRunId, stageId, model: stage.model }, 'pipeline stage dispatched');
    return;
  }

  finish(run, 'completed');
}

async function onStageDone(d: PipelineStageDonePayload): Promise<void> {
  const run = runs.get(d.pipelineRunId);
  if (!run) return;

  if (d.status === 'failed') {
    finish(run, 'failed', d.error);
    return;
  }

  // Merge the stage output into the run context so later stages can use it, then advance.
  if (d.output) run.context = { ...run.context, ...d.output };
  run.index++;
  await advance(run);
}

function finish(run: Run, status: 'completed' | 'failed', error?: string): void {
  runs.delete(run.pipelineRunId);
  const result: PipelineResultPayload = {
    userId: run.userId,
    pipelineId: run.pipelineId,
    pipelineRunId: run.pipelineRunId,
    status,
    error,
  };
  publish(channel, RK.PIPELINE_RESULT, result);
  log.info({ pipelineRunId: run.pipelineRunId, status }, 'pipeline run finished');
}
