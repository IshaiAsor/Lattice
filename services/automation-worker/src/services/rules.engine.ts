import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import type {
  UserRule,
  UserRuleCondition,
  UserRuleAction,
  UserDevice,
  UserDeviceAction,
  DeviceCapability,
  Device,
} from '@lattice/prisma-client';

const log = createLogger('automation-worker');

type UserRuleWithDetails = UserRule & {
  conditions: UserRuleCondition[];
  actions: UserRuleAction[];
};

type UserDeviceActionFull = UserDeviceAction & {
  capability: DeviceCapability;
  user_device: UserDevice & { device: Device };
};

class RulesEngine {
  async evaluateForUser(ch: Channel, userId: number): Promise<void> {
    try {
      const rules = (await db.userRule.findMany({
        where: { user_id: userId, enabled: true },
        include: { conditions: true, actions: true },
      })) as UserRuleWithDetails[];
      for (const rule of rules) {
        if (!this.isCooldownExpired(rule)) continue;
        const triggered = await this.evaluateRule(rule);
        if (triggered) {
          await this.executeRule(ch, userId, rule);
          await db.userRule.update({
            where: { id: rule.id },
            data: { last_triggered: new Date(), updated_at: new Date() },
          });
        }
      }
    } catch (err) {
      log.error({ err, userId }, 'error evaluating rules for user');
    }
  }

  async evaluateScheduledRules(ch: Channel): Promise<void> {
    try {
      const rules = await db.userRule.findMany({
        where: {
          enabled: true,
          conditions: { some: { condition_type: 'schedule' } },
        },
        select: { user_id: true },
        distinct: ['user_id'],
      });
      for (const { user_id } of rules) {
        await this.evaluateForUser(ch, user_id);
      }
    } catch (err) {
      log.error({ err }, 'error evaluating scheduled rules');
    }
  }

  private isCooldownExpired(rule: UserRuleWithDetails): boolean {
    if (!rule.last_triggered) return true;
    const elapsed = (Date.now() - rule.last_triggered.getTime()) / 1000;
    return elapsed >= rule.cooldown_seconds;
  }

  private async evaluateRule(rule: UserRuleWithDetails): Promise<boolean> {
    const results = await Promise.all(rule.conditions.map((c) => this.evaluateCondition(c)));
    return rule.condition_operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  private async evaluateCondition(condition: UserRuleCondition): Promise<boolean> {
    if (condition.condition_type === 'schedule') {
      return this.matchesScheduleNow(condition.schedule_time, condition.schedule_days);
    }

    if (
      condition.condition_type === 'device_state' ||
      condition.condition_type === 'device_status'
    ) {
      if (!condition.user_device_id || !condition.status_value) return false;
      try {
        const device = await db.userDevice.findUniqueOrThrow({
          where: { id: condition.user_device_id },
        });
        return condition.status_value === 'online' ? !!device.online : !device.online;
      } catch {
        return false;
      }
    }

    if (condition.condition_type === 'vlm_result' || condition.condition_type === 'vlm_decision') {
      log.warn(
        { condition_type: condition.condition_type },
        'vlm conditions not yet supported — F8 pending',
      );
      return false;
    }

    if (condition.condition_type === 'threshold') {
      if (
        !condition.user_device_action_id ||
        !condition.operator ||
        condition.threshold_value == null
      )
        return false;
      const action = await db.userDeviceAction.findUnique({
        where: { id: condition.user_device_action_id },
        include: { capability: true },
      });
      if (!action) return false;
      const current = parseFloat(action.current_state ?? '');
      const target = parseFloat(condition.threshold_value);
      if (isNaN(current) || isNaN(target)) return false;
      return this.compare(current, condition.operator, target);
    }

    return false;
  }

  private matchesScheduleNow(time: string | null, days: number[]): boolean {
    if (!time) return false;
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    if (`${hh}:${mm}` !== time) return false;
    if (!days || days.length === 0) return true;
    return days.includes(now.getDay());
  }

  private compare(a: number, op: string, b: number): boolean {
    switch (op) {
      case '>':
        return a > b;
      case '<':
        return a < b;
      case '>=':
        return a >= b;
      case '<=':
        return a <= b;
      case '=':
        return a === b;
      case '!=':
        return a !== b;
      default:
        return false;
    }
  }

  private async executeRule(ch: Channel, userId: number, rule: UserRuleWithDetails): Promise<void> {
    for (const ruleAction of rule.actions) {
      const dispatch = async () => {
        try {
          const uda = (await db.userDeviceAction.findUnique({
            where: { id: ruleAction.user_device_action_id },
            include: { capability: true, user_device: { include: { device: true } } },
          })) as UserDeviceActionFull | null;
          if (!uda) {
            log.warn(
              { actionId: ruleAction.user_device_action_id },
              'rule action target not found',
            );
            return;
          }
          const payload: ActionDispatchPayload = {
            userId: String(userId),
            deviceId: String(uda.user_device_id),
            actionName: uda.mqtt_action_name,
            command: { value: ruleAction.target_state, duration: '*' },
            firmwareVersion: uda.user_device.device.version ?? undefined,
          };
          publish(ch, RK.ACTION_DISPATCH, payload);
          log.info(
            {
              rule: rule.name,
              actionId: ruleAction.user_device_action_id,
              target: ruleAction.target_state,
            },
            'rule fired',
          );
        } catch (err) {
          log.error(
            { err, rule: rule.name, actionId: ruleAction.user_device_action_id },
            'error executing rule action',
          );
        }
      };

      if (ruleAction.delay_seconds > 0) {
        setTimeout(dispatch, ruleAction.delay_seconds * 1000);
      } else {
        await dispatch();
      }
    }
  }
}

export const rulesEngine = new RulesEngine();
