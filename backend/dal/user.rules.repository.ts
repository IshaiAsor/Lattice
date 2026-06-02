import db from '../config/db';
import { UserRule, UserRuleCondition, UserRuleAction } from '@prisma/client';

export type UserRuleWithDetails = UserRule & {
  conditions: UserRuleCondition[];
  actions: UserRuleAction[];
};

export type CreateRuleInput = {
  user_id: number;
  name: string;
  condition_operator: string;
  cooldown_seconds: number;
  conditions: { condition_type: string; parameters: object }[];
  actions: { user_device_action_id: number; target_state: string; delay_seconds: number }[];
};

class UserRulesRepository {
  async getAllByUserId(userId: number): Promise<UserRuleWithDetails[]> {
    return db.userRule.findMany({
      where: { user_id: userId },
      include: { conditions: true, actions: true },
      orderBy: { created_at: 'asc' },
    }) as Promise<UserRuleWithDetails[]>;
  }

  async getEnabledByUserId(userId: number): Promise<UserRuleWithDetails[]> {
    return db.userRule.findMany({
      where: { user_id: userId, enabled: true },
      include: { conditions: true, actions: true },
    }) as Promise<UserRuleWithDetails[]>;
  }

  async getById(id: number): Promise<UserRuleWithDetails> {
    return db.userRule.findFirstOrThrow({
      where: { id },
      include: { conditions: true, actions: true },
    }) as Promise<UserRuleWithDetails>;
  }

  async getUserIdsWithScheduledRules(): Promise<number[]> {
    const rules = await db.userRule.findMany({
      where: {
        enabled: true,
        conditions: { some: { condition_type: 'schedule' } },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    return rules.map((r) => r.user_id);
  }

  async create(data: CreateRuleInput): Promise<UserRuleWithDetails> {
    return db.userRule.create({
      data: {
        user_id: data.user_id,
        name: data.name,
        condition_operator: data.condition_operator,
        cooldown_seconds: data.cooldown_seconds,
        conditions: { create: data.conditions },
        actions: { create: data.actions },
      },
      include: { conditions: true, actions: true },
    }) as Promise<UserRuleWithDetails>;
  }

  async update(id: number, data: CreateRuleInput): Promise<UserRuleWithDetails> {
    return db.$transaction(async (tx) => {
      await tx.userRuleCondition.deleteMany({ where: { rule_id: id } });
      await tx.userRuleAction.deleteMany({ where: { rule_id: id } });
      return tx.userRule.update({
        where: { id },
        data: {
          name: data.name,
          condition_operator: data.condition_operator,
          cooldown_seconds: data.cooldown_seconds,
          updated_at: new Date(),
          conditions: { create: data.conditions },
          actions: { create: data.actions },
        },
        include: { conditions: true, actions: true },
      });
    }) as Promise<UserRuleWithDetails>;
  }

  async toggle(id: number, enabled: boolean): Promise<void> {
    await db.userRule.update({ where: { id }, data: { enabled, updated_at: new Date() } });
  }

  async delete(id: number): Promise<void> {
    await db.userRule.delete({ where: { id } });
  }

  async updateLastTriggered(id: number): Promise<void> {
    await db.userRule.update({ where: { id }, data: { last_triggered: new Date(), updated_at: new Date() } });
  }
}

export const userRulesRepository = new UserRulesRepository();
