import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload, NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import {
  resolveParam,
  isAutomationLive,
  isInstanceRunning,
  EMPTY_PARAM_CONTEXT,
  type ParamContext,
} from '@lattice/params';
import { compare, isCooldownExpired, matchesScheduleAt } from './rules-logic';
import { loadParamContexts } from './param-context';
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

// A rule derived from a blueprint stores references (`@phase.level.min`) where a hand-written
// rule stores literals, and they are resolved here rather than at write time — that is what lets
// a phase advance retune every rule by writing one column. A rule with no instance resolves
// against EMPTY_PARAM_CONTEXT, where every literal passes through and any reference fails closed.

class RulesEngine {
  async evaluateForUser(ch: Channel, userId: number): Promise<void> {
    try {
      const loaded = await db.userRule.findMany({
        where: { user_id: userId, enabled: true },
        include: { conditions: true, actions: true, area: { select: { id: true, name: true } } },
      });
      const rules = loaded as UserRuleWithDetails[];
      const areaById = new Map(loaded.map((r) => [r.id, r.area]));
      const contexts = await loadParamContexts(rules.map((r) => r.blueprint_instance_id));
      if (contexts.size > 0) {
        log.debug(
          { userId, rules: rules.length, blueprintInstances: [...contexts.keys()] },
          'evaluating rules with blueprint parameter contexts',
        );
      }
      for (const rule of rules) {
        if (!this.isCooldownExpired(rule)) continue;
        const ctx =
          (rule.blueprint_instance_id !== null
            ? contexts.get(rule.blueprint_instance_id)
            : undefined) ?? EMPTY_PARAM_CONTEXT;
        // Two gates, coarse first (F10.13 then F10). A rule is held when its setup is not running
        // — a stopped setup does nothing at all, emergencies included — and then when the rule's
        // phase scope does not cover the phase the setup is in. Empty scope (every hand-written
        // rule, and blueprint rules left unscoped) is always in scope. Both are read at evaluation
        // time, so starting, stopping or advancing changes what fires without touching a row.
        if (!isAutomationLive(rule.phase_scope, ctx.phase?.key ?? null, ctx.lifecycle)) {
          log.debug(
            {
              rule: rule.name,
              scope: rule.phase_scope,
              phase: ctx.phase?.key ?? null,
              lifecycle: ctx.lifecycle,
            },
            isInstanceRunning(ctx.lifecycle)
              ? 'rule skipped — not active in the current phase'
              : 'rule skipped — its setup is not running',
          );
          continue;
        }
        const triggered = await this.evaluateRule(rule, ctx);
        if (triggered) {
          await this.executeRule(ch, userId, rule, ctx);
          await db.userRule.update({
            where: { id: rule.id },
            data: { last_triggered: new Date(), updated_at: new Date() },
          });
          this.notifyRuleFired(ch, userId, rule, areaById.get(rule.id) ?? null);
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
    return isCooldownExpired(rule.last_triggered, rule.cooldown_seconds);
  }

  // Best-effort user notification when a rule fires (F15.4). Emergency rules use the `emergency`
  // event; the rest use `rule_fired`. dedupeKey is rule-scoped so distinct rules aren't
  // cross-suppressed and a flapping rule collapses within the notification dedupe window.
  // Dropped silently if notification-service isn't deployed (same contract as digest's OTA event).
  private notifyRuleFired(
    ch: Channel,
    userId: number,
    rule: UserRuleWithDetails,
    area: { id: number; name: string } | null,
  ): void {
    try {
      publish(ch, RK.NOTIFICATION_SEND, {
        userId: String(userId),
        eventType: rule.is_emergency ? 'emergency' : 'rule_fired',
        data: {
          ruleName: rule.name,
          title: rule.name,
          message: `Rule "${rule.name}" was triggered.`,
        },
        dedupeKey: `rule:${rule.id}`,
        // F10.7 — the area the rule belongs to, so a user with several setups can tell alerts
        // apart from the title. Omitted entirely for an untagged rule.
        ...(area ? { context: { area_id: area.id, area_name: area.name } } : {}),
      } satisfies NotificationSendPayload);
    } catch (err) {
      log.warn({ err, rule: rule.name }, 'failed to publish rule-fired notification — skipped');
    }
  }

  private async evaluateRule(rule: UserRuleWithDetails, ctx: ParamContext): Promise<boolean> {
    const results = await Promise.all(
      rule.conditions.map((c) => this.evaluateCondition(c, ctx, rule)),
    );
    return rule.condition_operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  private async evaluateCondition(
    condition: UserRuleCondition,
    ctx: ParamContext,
    rule: UserRuleWithDetails,
  ): Promise<boolean> {
    if (condition.condition_type === 'schedule') {
      return matchesScheduleAt(condition.schedule_time, condition.schedule_days);
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
      // Fail closed: an unresolvable reference means the rule does not fire, and says so once —
      // silently comparing against NaN would look identical to "the threshold was never crossed".
      const resolved = resolveParam(condition.threshold_value, ctx);
      if (resolved !== condition.threshold_value) {
        log.debug(
          { rule: rule.name, stored: condition.threshold_value, resolved, phase: ctx.phase?.key },
          'rule threshold resolved from a blueprint reference',
        );
      }
      if (resolved === null) {
        log.warn(
          { rule: rule.name, threshold: condition.threshold_value },
          'rule threshold references an unresolvable parameter — condition treated as false',
        );
        return false;
      }
      const action = await db.userDeviceAction.findUnique({
        where: { id: condition.user_device_action_id },
        include: { capability: true },
      });
      if (!action) return false;
      const current = parseFloat(action.current_state ?? '');
      const target = parseFloat(resolved);
      if (isNaN(current) || isNaN(target)) {
        log.debug(
          { rule: rule.name, current_state: action.current_state, resolved },
          'threshold condition skipped — current state or threshold is not numeric',
        );
        return false;
      }
      const met = compare(current, condition.operator, target);
      log.debug(
        { rule: rule.name, actionId: action.id, current, op: condition.operator, target, met },
        'threshold condition evaluated',
      );
      return met;
    }

    return false;
  }

  private async executeRule(
    ch: Channel,
    userId: number,
    rule: UserRuleWithDetails,
    ctx: ParamContext,
  ): Promise<void> {
    for (const ruleAction of rule.actions) {
      const dispatch = async () => {
        try {
          // Same fail-closed rule as the threshold: sending an unresolved "@param.pump.state"
          // to a device would be a command it cannot interpret.
          const target = resolveParam(ruleAction.target_state, ctx);
          if (target !== ruleAction.target_state) {
            log.debug(
              { rule: rule.name, stored: ruleAction.target_state, resolved: target },
              'rule action target resolved from a blueprint reference',
            );
          }
          if (target === null) {
            log.warn(
              { rule: rule.name, target_state: ruleAction.target_state },
              'rule action references an unresolvable parameter — not dispatched',
            );
            return;
          }
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
            command: { value: target, duration: '*' },
            firmwareVersion: uda.user_device.device.version ?? undefined,
          };
          publish(ch, RK.ACTION_DISPATCH, payload);
          log.info(
            { rule: rule.name, actionId: ruleAction.user_device_action_id, target },
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
