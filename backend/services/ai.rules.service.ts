import { db } from '@lattice/prisma-client';
import { createLogger } from '@lattice/logger';

const log = createLogger('api:ai-rules');

const ML_ROUTER_URL = process.env.ML_ROUTER_URL ?? 'http://localhost:3002';

// ─── Generated rule schema ────────────────────────────────────────────────────

export type GeneratedCondition = {
  kind:   string;
  params: Record<string, unknown>;
};

export type GeneratedAction = {
  kind:         'set_state' | 'run_pipeline';
  scope:        'capability' | 'instance' | 'group';
  capability?:  string;
  target_state?: string;
  pipeline_id?:  number;
};

export type GeneratedRule = {
  name:         string;
  match:        'AND' | 'OR';
  cooldown_sec: number;
  conditions:   GeneratedCondition[];
  actions:      GeneratedAction[];
};

export type RuleSet = { rules: GeneratedRule[] };

// ─── Generate rules ───────────────────────────────────────────────────────────

export type GenerateRulesInput = {
  userId:  number;
  goal:    string;          // what the user wants to achieve
  context?: string;         // optional free-text grower/operator notes
};

async function getUserContext(userId: number): Promise<{ capabilities: string[]; currentValues: Record<string, string> }> {
  const actions = await db.userAction.findMany({
    where: { user_device: { user_id: userId } },
    include: { action_def: true },
  });

  const capabilitySet = new Set<string>();
  const currentValues: Record<string, string> = {};

  for (const a of actions) {
    capabilitySet.add(a.action_def.capability);
    if (a.state != null) currentValues[a.action_def.capability] = a.state;
  }

  return { capabilities: [...capabilitySet], currentValues };
}

export async function generateRules(input: GenerateRulesInput): Promise<RuleSet> {
  const { userId, goal, context } = input;
  const { capabilities, currentValues } = await getUserContext(userId);

  const mlInput = {
    goal,
    context:        context ?? null,
    capabilities,
    current_values: currentValues,
  };

  const res = await fetch(`${ML_ROUTER_URL}/api/infer`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ kind: 'llm', name: 'rule_generator', version: '1.0', input: mlInput }),
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`ml-router /api/infer failed: ${res.status} ${await res.text()}`),
      { status: 502 },
    );
  }

  const body = await res.json() as { output: { raw: unknown } };
  const raw  = body.output?.raw as Record<string, unknown>;

  if (!Array.isArray((raw as any)?.rules)) {
    throw new Error('Model returned an invalid rule set — expected { rules: [...] }');
  }

  const ruleSet = raw as unknown as RuleSet;
  log.info({ userId, goal, ruleCount: ruleSet.rules.length }, 'rules generated');
  return ruleSet;
}

// ─── Apply rules ──────────────────────────────────────────────────────────────

const TAG = '[AI]';

export async function applyRules(
  userId: number,
  ruleSet: RuleSet,
  tag = TAG,
): Promise<{ created: number; rules: { id: number; name: string }[] }> {
  // Remove previously AI-generated rules with the same tag
  const existing = await db.rule.findMany({
    where: { user_id: userId, name: { startsWith: tag } },
    select: { id: true },
  });
  if (existing.length) {
    await db.rule.deleteMany({ where: { id: { in: existing.map((r) => r.id) } } });
    log.info({ userId, removed: existing.length }, 'removed previous AI rules');
  }

  const created: { id: number; name: string }[] = [];

  for (const r of ruleSet.rules) {
    const rule = await db.rule.create({
      data: {
        user_id:      userId,
        name:         r.name.startsWith(tag) ? r.name : `${tag} ${r.name}`,
        match:        r.match ?? 'AND',
        cooldown_sec: r.cooldown_sec ?? 60,
        enabled:      true,
        conditions:   { create: r.conditions.map((c) => ({ kind: c.kind, params: c.params as any })) },
        actions:      { create: r.actions.map((a) => ({ ...a } as any)) },
      },
    });
    created.push({ id: rule.id, name: rule.name });
  }

  log.info({ userId, created: created.length }, 'AI rules applied');
  return { created: created.length, rules: created };
}
