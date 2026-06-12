import db from '../config/db';
import { Rule, RuleCondition, RuleAction, RuleActionKind, RuleActionScope } from '@lattice/prisma-client';

export type RuleWithDetails = Rule & {
  conditions: RuleCondition[];
  actions: RuleAction[];
};

export type CreateConditionInput = {
  kind: string;
  params: object;
};

export type CreateRuleActionInput = {
  kind?: RuleActionKind;
  scope?: RuleActionScope;
  user_action_id?: number | null;
  capability?: string | null;
  group_id?: number | null;
  target_state?: string | null;
  pipeline_id?: number | null;
  delay_sec?: number;
};

export type CreateRuleInput = {
  user_id: number;
  name: string;
  match: string;
  cooldown_sec: number;
  conditions: CreateConditionInput[];
  actions: CreateRuleActionInput[];
};

class RulesRepository {
  async getAllByUserId(userId: number): Promise<RuleWithDetails[]> {
    return db.rule.findMany({
      where: { user_id: userId },
      include: { conditions: true, actions: true },
      orderBy: { created_at: 'asc' },
    });
  }

  async getEnabledByUserId(userId: number): Promise<RuleWithDetails[]> {
    return db.rule.findMany({
      where: { user_id: userId, enabled: true },
      include: { conditions: true, actions: true },
    });
  }

  async getById(id: number): Promise<RuleWithDetails> {
    return db.rule.findFirstOrThrow({
      where: { id },
      include: { conditions: true, actions: true },
    });
  }

  async getUserIdsWithScheduledRules(): Promise<number[]> {
    const rules = await db.rule.findMany({
      where: { enabled: true, conditions: { some: { kind: 'schedule' } } },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    return rules.map((r) => r.user_id);
  }

  async create(data: CreateRuleInput): Promise<RuleWithDetails> {
    return db.rule.create({
      data: {
        user_id: data.user_id,
        name: data.name,
        match: data.match,
        cooldown_sec: data.cooldown_sec,
        conditions: { create: data.conditions },
        actions:    { create: data.actions },
      },
      include: { conditions: true, actions: true },
    });
  }

  async update(id: number, data: CreateRuleInput): Promise<RuleWithDetails> {
    return db.$transaction(async (tx) => {
      await tx.ruleCondition.deleteMany({ where: { rule_id: id } });
      await tx.ruleAction.deleteMany({   where: { rule_id: id } });
      return tx.rule.update({
        where: { id },
        data: {
          name: data.name,
          match: data.match,
          cooldown_sec: data.cooldown_sec,
          updated_at: new Date(),
          conditions: { create: data.conditions },
          actions:    { create: data.actions },
        },
        include: { conditions: true, actions: true },
      });
    });
  }

  async toggle(id: number, enabled: boolean): Promise<void> {
    await db.rule.update({ where: { id }, data: { enabled, updated_at: new Date() } });
  }

  async delete(id: number): Promise<void> {
    await db.rule.delete({ where: { id } });
  }

  async updateLastFired(id: number): Promise<void> {
    await db.rule.update({ where: { id }, data: { last_fired_at: new Date(), updated_at: new Date() } });
  }
}

export const rulesRepository = new RulesRepository();
