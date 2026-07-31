import { db } from '../db';

// User automation rules (F6.3) — unified with emergencies via `is_emergency` (F9 folds in
// here, no separate table). Conditions use typed columns (F1.7), matching what the
// automation-worker reads, so rules created here fire correctly.

export interface RuleConditionDto {
  condition_type: string; // threshold | device_state | device_status | schedule | vlm
  user_device_action_id?: number | null;
  operator?: string | null;
  threshold_value?: string | null;
  user_device_id?: number | null;
  status_value?: string | null;
  schedule_time?: string | null;
  schedule_days?: number[];
}

export interface RuleActionDto {
  user_device_action_id: number;
  target_state: string;
  delay_seconds: number;
}

export interface CreateRuleDto {
  name: string;
  condition_operator: 'AND' | 'OR';
  cooldown_seconds: number;
  is_emergency?: boolean;
  conditions: RuleConditionDto[];
  actions: RuleActionDto[];
}

export interface RuleConditionView extends RuleConditionDto {
  id: number;
}
export interface RuleActionView extends RuleActionDto {
  id: number;
}
export interface RuleView {
  id: number;
  name: string;
  enabled: boolean;
  is_emergency: boolean;
  condition_operator: string;
  cooldown_seconds: number;
  // Phases this rule is active in (F10, blueprint-authored). Empty = every phase.
  phase_scope: string[];
  last_triggered: Date | null;
  conditions: RuleConditionView[];
  actions: RuleActionView[];
}

function validate(dto: CreateRuleDto): void {
  if (!dto || typeof dto.name !== 'string' || !dto.name.trim()) {
    throw Object.assign(new Error('name is required'), { statusCode: 400 });
  }
  if (!Array.isArray(dto.conditions) || dto.conditions.length === 0) {
    throw Object.assign(new Error('at least one condition is required'), { statusCode: 400 });
  }
  if (!Array.isArray(dto.actions) || dto.actions.length === 0) {
    throw Object.assign(new Error('at least one action is required'), { statusCode: 400 });
  }
}

function conditionCreateData(c: RuleConditionDto) {
  return {
    condition_type: c.condition_type,
    user_device_action_id: c.user_device_action_id ?? null,
    operator: c.operator ?? null,
    threshold_value: c.threshold_value ?? null,
    user_device_id: c.user_device_id ?? null,
    status_value: c.status_value ?? null,
    schedule_time: c.schedule_time ?? null,
    schedule_days: c.schedule_days ?? [],
  };
}

class RulesService {
  async list(userId: number): Promise<RuleView[]> {
    const rules = await db.userRule.findMany({
      where: { user_id: userId },
      orderBy: { id: 'asc' },
      include: { conditions: { orderBy: { id: 'asc' } }, actions: { orderBy: { id: 'asc' } } },
    });
    return rules.map((r) => this.toView(r));
  }

  async create(userId: number, dto: CreateRuleDto): Promise<RuleView> {
    validate(dto);
    const rule = await db.userRule.create({
      data: {
        user_id: userId,
        name: dto.name.trim(),
        condition_operator: dto.condition_operator === 'OR' ? 'OR' : 'AND',
        cooldown_seconds: dto.cooldown_seconds ?? 60,
        is_emergency: dto.is_emergency ?? false,
        conditions: { create: dto.conditions.map(conditionCreateData) },
        actions: {
          create: dto.actions.map((a) => ({
            user_device_action_id: a.user_device_action_id,
            target_state: a.target_state,
            delay_seconds: a.delay_seconds ?? 0,
          })),
        },
      },
      include: { conditions: { orderBy: { id: 'asc' } }, actions: { orderBy: { id: 'asc' } } },
    });
    return this.toView(rule);
  }

  async update(userId: number, id: number, dto: CreateRuleDto): Promise<RuleView> {
    validate(dto);
    const existing = await this.ensureOwned(userId, id);
    // Editing a blueprint-derived rule is what "drift" means (F10.6): from here on reconcile
    // leaves this row alone and the instance page offers a reset. Only structural edits count —
    // enabling/disabling is not an opinion about the rule's content.
    const userModified = existing.blueprint_instance_id !== null ? true : undefined;
    // Replace conditions/actions wholesale so removed rows don't linger.
    const rule = await db.$transaction(async (tx) => {
      await tx.userRuleCondition.deleteMany({ where: { rule_id: id } });
      await tx.userRuleAction.deleteMany({ where: { rule_id: id } });
      return tx.userRule.update({
        where: { id },
        data: {
          name: dto.name.trim(),
          condition_operator: dto.condition_operator === 'OR' ? 'OR' : 'AND',
          cooldown_seconds: dto.cooldown_seconds ?? 60,
          is_emergency: dto.is_emergency ?? false,
          user_modified: userModified,
          updated_at: new Date(),
          conditions: { create: dto.conditions.map(conditionCreateData) },
          actions: {
            create: dto.actions.map((a) => ({
              user_device_action_id: a.user_device_action_id,
              target_state: a.target_state,
              delay_seconds: a.delay_seconds ?? 0,
            })),
          },
        },
        include: { conditions: { orderBy: { id: 'asc' } }, actions: { orderBy: { id: 'asc' } } },
      });
    });
    return this.toView(rule);
  }

  // Recent fire events for the user's rules (UserRuleEvent). `emergencyOnly` restricts to
  // rules flagged is_emergency — the dashboard's emergency-alert count.
  async listEvents(
    userId: number,
    limit: number,
    emergencyOnly: boolean,
  ): Promise<{ id: number; rule_id: number; triggered_value: string | null; fired_at: Date }[]> {
    const events = await db.userRuleEvent.findMany({
      where: { rule: { user_id: userId, ...(emergencyOnly ? { is_emergency: true } : {}) } },
      orderBy: { fired_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: { id: true, rule_id: true, triggered_value: true, fired_at: true },
    });
    return events;
  }

  async setEnabled(userId: number, id: number, enabled: boolean): Promise<void> {
    await this.ensureOwned(userId, id);
    await db.userRule.update({ where: { id }, data: { enabled, updated_at: new Date() } });
  }

  async remove(userId: number, id: number): Promise<void> {
    await this.ensureOwned(userId, id);
    await db.userRule.delete({ where: { id } }); // cascades conditions/actions/events
  }

  private async ensureOwned(
    userId: number,
    id: number,
  ): Promise<{ blueprint_instance_id: number | null }> {
    const rule = await db.userRule.findUnique({
      where: { id },
      select: { user_id: true, blueprint_instance_id: true },
    });
    if (!rule) throw Object.assign(new Error('Rule not found'), { statusCode: 404 });
    if (rule.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return { blueprint_instance_id: rule.blueprint_instance_id };
  }

  private toView(r: {
    id: number;
    name: string;
    enabled: boolean;
    is_emergency: boolean;
    condition_operator: string;
    cooldown_seconds: number;
    phase_scope: string[];
    last_triggered: Date | null;
    conditions: {
      id: number;
      condition_type: string;
      user_device_action_id: number | null;
      operator: string | null;
      threshold_value: string | null;
      user_device_id: number | null;
      status_value: string | null;
      schedule_time: string | null;
      schedule_days: number[];
    }[];
    actions: {
      id: number;
      user_device_action_id: number;
      target_state: string;
      delay_seconds: number;
    }[];
  }): RuleView {
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      is_emergency: r.is_emergency,
      condition_operator: r.condition_operator,
      cooldown_seconds: r.cooldown_seconds,
      phase_scope: r.phase_scope,
      last_triggered: r.last_triggered,
      conditions: r.conditions.map((c) => ({
        id: c.id,
        condition_type: c.condition_type,
        user_device_action_id: c.user_device_action_id,
        operator: c.operator,
        threshold_value: c.threshold_value,
        user_device_id: c.user_device_id,
        status_value: c.status_value,
        schedule_time: c.schedule_time,
        schedule_days: c.schedule_days,
      })),
      actions: r.actions.map((a) => ({
        id: a.id,
        user_device_action_id: a.user_device_action_id,
        target_state: a.target_state,
        delay_seconds: a.delay_seconds,
      })),
    };
  }
}

export const rulesService = new RulesService();
