import { valkey, keys } from '../shared/valkey';
import { db } from '@lattice/prisma-client';
import type { RuleCondition } from '@lattice/prisma-client';

// ─── Condition param shapes ───────────────────────────────────────────────────

type ThresholdParams    = { userActionId: number; operator: string; value: string };
type DeviceStatusParams = { userDeviceId: number; status: 'online' | 'offline' };
type PipelineResultParams = { pipelineId: number; decision?: string; status?: string };

function compareValues(operator: string, actual: number, expected: number): boolean {
  switch (operator) {
    case '>':  return actual >  expected;
    case '<':  return actual <  expected;
    case '>=': return actual >= expected;
    case '<=': return actual <= expected;
    case '=':
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    default:   return false;
  }
}

// ─── Evaluators ───────────────────────────────────────────────────────────────

// schedule: always true when called by the automation-worker's per-minute cron tick
async function evaluateSchedule(_params: unknown): Promise<boolean> {
  return true;
}

async function evaluateThreshold(params: ThresholdParams): Promise<boolean> {
  const raw = await valkey.get(keys.actionState(params.userActionId));
  if (raw === null) return false;
  const actual   = parseFloat(raw);
  const expected = parseFloat(params.value);
  if (isNaN(actual) || isNaN(expected)) return false;
  return compareValues(params.operator, actual, expected);
}

async function evaluateDeviceStatus(params: DeviceStatusParams): Promise<boolean> {
  const exists = await valkey.exists(keys.deviceOnline(params.userDeviceId));
  const isOnline = exists === 1;
  return params.status === 'online' ? isOnline : !isOnline;
}

async function evaluatePipelineResult(params: PipelineResultParams): Promise<boolean> {
  const run = await db.pipelineRun.findFirst({
    where: { pipeline_id: params.pipelineId, status: 'completed' },
    orderBy: { finished_at: 'desc' },
    select: { output: true, status: true },
  });
  if (!run) return false;
  if (params.status && run.status !== params.status) return false;
  if (params.decision && run.output) {
    const output = run.output as Record<string, unknown>;
    return output?.decision === params.decision;
  }
  return true;
}

// ─── Main evaluator ───────────────────────────────────────────────────────────

export async function evaluateCondition(condition: RuleCondition): Promise<boolean> {
  const params = condition.params as Record<string, unknown>;
  switch (condition.kind) {
    case 'schedule':
      return evaluateSchedule(params);
    case 'threshold':
      return evaluateThreshold(params as unknown as ThresholdParams);
    case 'device_status':
      return evaluateDeviceStatus(params as unknown as DeviceStatusParams);
    case 'vlm_result':
    case 'pipeline_result':
      return evaluatePipelineResult(params as unknown as PipelineResultParams);
    default:
      return false;
  }
}

export async function evaluateConditions(
  conditions: RuleCondition[],
  match: string,  // 'AND' | 'OR'
): Promise<boolean> {
  if (conditions.length === 0) return false;

  if (match === 'OR') {
    for (const c of conditions) {
      if (await evaluateCondition(c)) return true;
    }
    return false;
  }

  // AND (default)
  for (const c of conditions) {
    if (!(await evaluateCondition(c))) return false;
  }
  return true;
}
