// OTel first
import { startOtel } from '@lattice/otel';
startOtel('automation-worker');

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../../../.env') });
import cron from 'node-cron';
import { createLogger } from '@lattice/logger';
import { connectQueue, consume, publish, QUEUES, RK } from '@lattice/queue';
import type { RulesEvaluatePayload, PipelineResultPayload, ActionDispatchPayload } from '@lattice/queue';
import { db } from '@lattice/prisma-client';
import type { Rule, RuleCondition, RuleAction } from '@lattice/prisma-client';
import { evaluateConditions } from './conditions';

const log = createLogger('automation-worker');

// ─── Action fan-out helpers ───────────────────────────────────────────────────

type ActionWithScope = Pick<RuleAction, 'kind' | 'scope' | 'user_action_id' | 'capability' | 'group_id' | 'target_state' | 'pipeline_id' | 'delay_sec'>;

async function resolveTargetActions(
  userId: number,
  action: ActionWithScope,
): Promise<{ userDeviceId: number; userActionId: number; mqttType: string | null; mqttName: string | null }[]> {
  if (action.scope === 'instance' && action.user_action_id) {
    const ua = await db.userAction.findUnique({
      where: { id: action.user_action_id },
      include: { action_def: true, user_device: true },
    });
    if (!ua) return [];
    return [{ userDeviceId: ua.user_device_id, userActionId: ua.id, mqttType: ua.action_def.mqtt_type, mqttName: ua.action_def.mqtt_name }];
  }

  if (action.scope === 'capability' && action.capability) {
    const rows = await db.userAction.findMany({
      where: { user_device: { user_id: userId }, action_def: { capability: action.capability } },
      include: { action_def: true },
    });
    return rows.map((ua) => ({ userDeviceId: ua.user_device_id, userActionId: ua.id, mqttType: ua.action_def.mqtt_type, mqttName: ua.action_def.mqtt_name }));
  }

  if (action.scope === 'group' && action.group_id) {
    const rows = await db.userAction.findMany({
      where: { user_action_group_id: action.group_id },
      include: { action_def: true },
    });
    return rows.map((ua) => ({ userDeviceId: ua.user_device_id, userActionId: ua.id, mqttType: ua.action_def.mqtt_type, mqttName: ua.action_def.mqtt_name }));
  }

  return [];
}

async function dispatchRuleAction(
  userId: number,
  action: ActionWithScope,
  traceId?: string,
): Promise<void> {
  if (action.kind === 'run_pipeline' && action.pipeline_id) {
    await publish(RK.pipelineTrigger(userId), { userId, pipelineId: action.pipeline_id, traceId });
    return;
  }

  // set_state: resolve targets and dispatch via action.dispatch
  const targets = await resolveTargetActions(userId, action);
  await Promise.all(
    targets.map((t) =>
      publish<ActionDispatchPayload>(RK.actionDispatch(userId), {
        userId,
        userDeviceId: t.userDeviceId,
        mqttType: t.mqttType ?? 'command',
        mqttName: t.mqttName ?? String(t.userActionId),
        value: action.target_state ?? '1',
        traceId,
      }),
    ),
  );
}

// ─── Rule evaluator ───────────────────────────────────────────────────────────

async function evaluateRulesForUser(userId: number, traceId?: string): Promise<void> {
  const rules = await db.rule.findMany({
    where: { user_id: userId, enabled: true },
    include: { conditions: true, actions: true },
  });

  const now = Date.now();

  for (const rule of rules) {
    // Cooldown check
    const lastFired = rule.last_fired_at ? rule.last_fired_at.getTime() : 0;
    if (now - lastFired < rule.cooldown_sec * 1000) continue;

    const matched = await evaluateConditions(rule.conditions as RuleCondition[], rule.match);
    if (!matched) continue;

    log.info({ ruleId: rule.id, ruleName: rule.name, userId }, 'rule fired');

    // Update last_fired_at (fire-and-forget)
    db.rule.update({
      where: { id: rule.id },
      data: { last_fired_at: new Date(), updated_at: new Date() },
    }).catch((err) => log.error(err, 'Failed to update rule.last_fired_at'));

    // Dispatch each action
    await Promise.all(
      (rule.actions as RuleAction[]).map((a) => dispatchRuleAction(userId, a, traceId)),
    );
  }
}

// ─── Consumers ───────────────────────────────────────────────────────────────

async function handleRulesEvaluate(
  payload: RulesEvaluatePayload,
  _headers: Record<string, string>,
  ack: () => void,
  nack: (requeue?: boolean) => void,
): Promise<void> {
  try {
    await evaluateRulesForUser(payload.userId, payload.traceId);
    ack();
  } catch (err) {
    log.error(err, 'rules.evaluate failed');
    nack(false);
  }
}

async function handlePipelineResult(
  payload: PipelineResultPayload,
  _headers: Record<string, string>,
  ack: () => void,
  nack: (requeue?: boolean) => void,
): Promise<void> {
  try {
    // Re-evaluate rules that have pipeline_result conditions referencing this pipeline
    const rulesWithPipelineCondition = await db.rule.findMany({
      where: {
        user_id: payload.userId,
        enabled: true,
        conditions: { some: { kind: { in: ['pipeline_result', 'vlm_result'] } } },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });

    if (rulesWithPipelineCondition.length > 0) {
      await evaluateRulesForUser(payload.userId, payload.traceId);
    }
    ack();
  } catch (err) {
    log.error(err, 'pipeline.result handler failed');
    nack(false);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await connectQueue();

  await consume<RulesEvaluatePayload>(QUEUES.rulesEvaluate, handleRulesEvaluate, /* prefetch */ 1);
  await consume<PipelineResultPayload>(QUEUES.pipelineResult, handlePipelineResult, /* prefetch */ 1);

  // Scheduled rule trigger: every minute, publish rules.evaluate for users with schedule conditions
  cron.schedule('* * * * *', async () => {
    try {
      const rows = await db.rule.findMany({
        where: { enabled: true, conditions: { some: { kind: 'schedule' } } },
        select: { user_id: true },
        distinct: ['user_id'],
      });
      await Promise.all(rows.map((r) => publish(RK.rulesEvaluate(r.user_id), { userId: r.user_id })));
      if (rows.length) log.debug({ userCount: rows.length }, 'scheduled rules.evaluate published');
    } catch (err) {
      log.error(err, 'scheduled rules.evaluate dispatch failed');
    }
  });

  log.info('automation-worker started');
}

start().catch((err) => {
  log.error(err, 'automation-worker failed to start');
  process.exit(1);
});
