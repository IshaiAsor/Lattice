import db from '../config/db';
import { EmergencyRule, EmergencyEvent, RuleActionScope } from '@lattice/prisma-client';

export type EmergencyRuleFull = EmergencyRule & {
  source_action: { name: string } | null;
};

export type CreateEmergencyRuleInput = {
  user_id: number;
  name: string;
  source_scope?: RuleActionScope;
  source_user_action_id?: number | null;
  source_capability?: string | null;
  source_group_id?: number | null;
  operator: string;
  threshold: string;
  target_scope?: RuleActionScope;
  target_user_action_id?: number | null;
  target_capability?: string | null;
  target_group_id?: number | null;
  target_state?: string | null;
};

class EmergencyRepository {
  async getByUserId(userId: number): Promise<EmergencyRuleFull[]> {
    return db.emergencyRule.findMany({
      where: { user_id: userId },
      include: { source_action: { select: { name: true } } },
      orderBy: { created_at: 'asc' },
    }) as Promise<EmergencyRuleFull[]>;
  }

  /** Instance-scoped lookup (hot path — called from device-gateway). */
  async getEnabledBySourceActionId(actionId: number): Promise<EmergencyRule[]> {
    return db.emergencyRule.findMany({ where: { source_user_action_id: actionId, enabled: true } });
  }

  /** Matches both instance (by actionId) AND capability-scoped rules. */
  async getEnabledMatching(actionId: number, capability: string): Promise<EmergencyRule[]> {
    return db.emergencyRule.findMany({
      where: {
        enabled: true,
        OR: [
          { source_user_action_id: actionId },
          { source_scope: 'capability', source_capability: capability },
        ],
      },
    });
  }

  async create(data: CreateEmergencyRuleInput): Promise<EmergencyRule> {
    return db.emergencyRule.create({ data });
  }

  async toggle(id: number, userId: number, enabled: boolean): Promise<void> {
    await db.emergencyRule.updateMany({ where: { id, user_id: userId }, data: { enabled } });
  }

  async delete(id: number, userId: number): Promise<void> {
    await db.emergencyRule.deleteMany({ where: { id, user_id: userId } });
  }

  async logEvent(ruleId: number, value: string, traceId?: string): Promise<EmergencyEvent> {
    return db.emergencyEvent.create({ data: { emergency_rule_id: ruleId, value, trace_id: traceId } });
  }

  async getRecentEvents(userId: number, limit = 50): Promise<EmergencyEvent[]> {
    return db.emergencyEvent.findMany({
      where: { rule: { user_id: userId } },
      include: { rule: { select: { name: true } } },
      orderBy: { fired_at: 'desc' },
      take: limit,
    }) as Promise<EmergencyEvent[]>;
  }
}

export const emergencyRepository = new EmergencyRepository();
