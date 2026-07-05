import type { Channel } from 'amqplib';
import { db, Prisma } from '@lattice/prisma-client';
import { createLogger } from '@lattice/logger';
import { publish, RK } from '@lattice/queue';
import type { Run } from '../types';
import type { PipelineStagePlan } from '../registry';

const log = createLogger('ml-router:pipeline:command-exec');

interface LlmAction {
  user_device_action_id?: number;
  value?: unknown;
  reasoning?: string;
}

export async function runCommandExec(
  channel: Channel,
  run: Run,
  stage: Extract<PipelineStagePlan, { type: 'command_exec' }>,
): Promise<void> {
  log.info({ runId: run.runId, stageId: stage.dbId, isDryRun: run.isDryRun }, 'command_exec stage starting');
  const started = new Date();
  const prevOutput = run.context as { actions?: LlmAction[] };
  const actions = (prevOutput.actions ?? []).filter(
    (a): a is LlmAction & { user_device_action_id: number } => a.user_device_action_id != null,
  );

  if (run.isDryRun) {
    const wouldExecute = actions.map(a => ({
      user_device_action_id: a.user_device_action_id,
      value:     a.value ?? null,
      reasoning: a.reasoning ?? null,
    }));
    const output = { would_execute: wouldExecute, dry_run: true } as Prisma.InputJsonValue;
    await db.pipelineRunStage.upsert({
      where:  { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
      update: { status: 'completed', output, completed_at: new Date() },
      create: { run_id: run.runId, stage_id: stage.dbId, status: 'completed', output, started_at: started, completed_at: new Date() },
    });
    log.info({ runId: run.runId, wouldExecute }, '[dry-run] command_exec would execute');
    return;
  }

  if (actions.length === 0) {
    log.warn({ runId: run.runId }, 'command_exec: no actions from LLM output — skipping dispatch');
    const output = { skipped: true, reason: 'no actions in LLM output' } as Prisma.InputJsonValue;
    await db.pipelineRunStage.upsert({
      where:  { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
      update: { status: 'completed', output, completed_at: new Date() },
      create: { run_id: run.runId, stage_id: stage.dbId, status: 'completed', output, started_at: started, completed_at: new Date() },
    });
    return;
  }

  // Validate ownership of every action before dispatching any of them, so a run either
  // executes as a whole batch or throws without side effects.
  log.trace({ runId: run.runId, actionIds: actions.map(a => a.user_device_action_id) }, 'validating action ownership');
  const owned = await db.userDeviceAction.findMany({
    where: { id: { in: actions.map(a => a.user_device_action_id) } },
    include: { user_device: { select: { user_id: true } } },
  });
  const ownedById = new Map(owned.map(a => [a.id, a]));
  for (const a of actions) {
    const found = ownedById.get(a.user_device_action_id);
    if (!found || found.user_device.user_id !== run.userId) {
      throw new Error(`command_exec: action ${a.user_device_action_id} not owned by user ${run.userId}`);
    }
  }

  const executed = actions.map(a => {
    publish(channel, RK.ACTION_REQUESTED, {
      userId:   String(run.userId),
      actionId: a.user_device_action_id,
      value:    a.value,
    });
    return { user_device_action_id: a.user_device_action_id, value: String(a.value), reasoning: a.reasoning };
  });
  log.trace({ runId: run.runId, actionIds: actions.map(a => a.user_device_action_id) }, 'ACTION_REQUESTED published');

  const output = { executed } as Prisma.InputJsonValue;
  await db.pipelineRunStage.upsert({
    where:  { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
    update: { status: 'completed', output, completed_at: new Date() },
    create: { run_id: run.runId, stage_id: stage.dbId, status: 'completed', output, started_at: started, completed_at: new Date() },
  });
  log.info({ runId: run.runId, executed }, 'command_exec dispatched');
}
