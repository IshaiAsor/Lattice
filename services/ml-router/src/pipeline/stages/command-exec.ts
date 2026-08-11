import type { Channel } from 'amqplib';
import { db, Prisma } from '@lattice/prisma-client';
import { createLogger } from '@lattice/logger';
import { publish, RK } from '@lattice/queue';
import type { BlueprintPhaseAdvancePayload } from '@lattice/queue';
import type { Run } from '../types';
import type { PhaseAdvancePlan, PipelineStagePlan } from '../registry';

const log = createLogger('ml-router:pipeline:command-exec');

interface LlmAction {
  user_device_action_id?: number;
  value?: unknown;
  reasoning?: string;
}

// The model's phase decision, but only when this pipeline is authorised to make it (the plan says
// so) AND the model actually chose to advance. Null otherwise, which is every pipeline that is not
// a phase decider, and every run where the model left the phase alone.
function phaseAdvanceRequested(
  run: Run,
): { plan: PhaseAdvancePlan; reasoning: string | null } | null {
  const plan = run.plan.phaseAdvance;
  if (!plan) return null;
  const pt = (run.context as { phase_transition?: { advance?: unknown; reasoning?: unknown } })
    .phase_transition;
  if (!pt || pt.advance !== true) return null;
  return { plan, reasoning: typeof pt.reasoning === 'string' ? pt.reasoning : null };
}

export async function runCommandExec(
  channel: Channel,
  run: Run,
  stage: Extract<PipelineStagePlan, { type: 'command_exec' }>,
): Promise<void> {
  log.info(
    { runId: run.runId, stageId: stage.dbId, isDryRun: run.isDryRun },
    'command_exec stage starting',
  );
  const started = new Date();
  const prevOutput = run.context as { actions?: LlmAction[] };
  const actions = (prevOutput.actions ?? []).filter(
    (a): a is LlmAction & { user_device_action_id: number } => a.user_device_action_id != null,
  );
  const advance = phaseAdvanceRequested(run);
  const advanceAudit = advance
    ? {
        instance_id: advance.plan.instanceId,
        binding_id: advance.plan.bindingId,
        from_phase: advance.plan.currentPhaseName,
        reasoning: advance.reasoning,
      }
    : null;

  if (run.isDryRun) {
    const wouldExecute = actions.map((a) => ({
      user_device_action_id: a.user_device_action_id,
      value: a.value ?? null,
      reasoning: a.reasoning ?? null,
    }));
    const output = {
      would_execute: wouldExecute,
      ...(advanceAudit ? { would_advance: advanceAudit } : {}),
      dry_run: true,
    } as Prisma.InputJsonValue;
    await db.pipelineRunStage.upsert({
      where: { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
      update: { status: 'completed', output, completed_at: new Date() },
      create: {
        run_id: run.runId,
        stage_id: stage.dbId,
        status: 'completed',
        output,
        started_at: started,
        completed_at: new Date(),
      },
    });
    log.info(
      { runId: run.runId, wouldExecute, wouldAdvance: advanceAudit },
      '[dry-run] command_exec would execute',
    );
    return;
  }

  // A phase advance stands on its own — the model can end a phase while recommending no device
  // action — so publish it before the no-actions early return. automation-worker is the single
  // writer: it re-checks the lifecycle and moves exactly the one owner named here.
  if (advance) {
    publish(channel, RK.BLUEPRINT_PHASE_ADVANCE, {
      userId: String(run.userId),
      instanceId: advance.plan.instanceId,
      bindingId: advance.plan.bindingId,
      source: 'pipeline',
      // Carried so the consumer can re-check that the owner's phase still names this pipeline —
      // the plan's own gate was evaluated before the model call, several seconds ago.
      refKey: advance.plan.refKey,
    } satisfies BlueprintPhaseAdvancePayload);
    log.info(
      { runId: run.runId, instanceId: advance.plan.instanceId, bindingId: advance.plan.bindingId },
      'command_exec requested phase advance',
    );
  }

  if (actions.length === 0) {
    if (!advance) {
      log.warn(
        { runId: run.runId },
        'command_exec: no actions from LLM output — skipping dispatch',
      );
    }
    const output = {
      skipped: actions.length === 0,
      reason: 'no actions in LLM output',
      ...(advanceAudit ? { phase_advance: advanceAudit } : {}),
    } as Prisma.InputJsonValue;
    await db.pipelineRunStage.upsert({
      where: { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
      update: { status: 'completed', output, completed_at: new Date() },
      create: {
        run_id: run.runId,
        stage_id: stage.dbId,
        status: 'completed',
        output,
        started_at: started,
        completed_at: new Date(),
      },
    });
    return;
  }

  // Validate ownership of every action before dispatching any of them, so a run either
  // executes as a whole batch or throws without side effects.
  log.trace(
    { runId: run.runId, actionIds: actions.map((a) => a.user_device_action_id) },
    'validating action ownership',
  );
  const owned = await db.userDeviceAction.findMany({
    where: { id: { in: actions.map((a) => a.user_device_action_id) } },
    include: { user_device: { select: { user_id: true } } },
  });
  const ownedById = new Map(owned.map((a) => [a.id, a]));
  for (const a of actions) {
    const found = ownedById.get(a.user_device_action_id);
    if (!found || found.user_device.user_id !== run.userId) {
      throw new Error(
        `command_exec: action ${a.user_device_action_id} not owned by user ${run.userId}`,
      );
    }
  }

  const executed = actions.map((a) => {
    publish(channel, RK.ACTION_REQUESTED, {
      userId: String(run.userId),
      actionId: a.user_device_action_id,
      value: a.value,
      // So the command history can say which pipeline decided this, and the model's own reasoning
      // stays findable beside it in the run's stage audit (F11.12).
      source: { kind: 'pipeline', refId: run.pipelineId, label: run.plan.name },
    });
    return {
      user_device_action_id: a.user_device_action_id,
      value: String(a.value),
      reasoning: a.reasoning,
    };
  });
  log.trace(
    { runId: run.runId, actionIds: actions.map((a) => a.user_device_action_id) },
    'ACTION_REQUESTED published',
  );

  const output = {
    executed,
    ...(advanceAudit ? { phase_advance: advanceAudit } : {}),
  } as Prisma.InputJsonValue;
  await db.pipelineRunStage.upsert({
    where: { run_id_stage_id: { run_id: run.runId, stage_id: stage.dbId } },
    update: { status: 'completed', output, completed_at: new Date() },
    create: {
      run_id: run.runId,
      stage_id: stage.dbId,
      status: 'completed',
      output,
      started_at: started,
      completed_at: new Date(),
    },
  });
  log.info({ runId: run.runId, executed }, 'command_exec dispatched');
}
