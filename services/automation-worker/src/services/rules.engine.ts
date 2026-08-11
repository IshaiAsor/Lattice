import { randomUUID } from 'node:crypto';
import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload, NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import {
  resolveParam,
  resolveClock,
  resolveSeconds,
  firedThisMinute,
  isAutomationLive,
  isInstanceRunning,
  matchesSchedule,
  EMPTY_PARAM_CONTEXT,
  type ParamContext,
} from '@lattice/params';
import { compare, isCooldownExpired } from './rules-logic';
import { loadParamContexts, contextKey } from './param-context';
import { advanceSetupPhase, advanceBindingPhase } from './phases.service';
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

/**
 * A rule with a schedule condition fires *on a minute*, which is why it needs the minute guard and
 * the atomic claim below. A rule without one fires on state, where firing twice in a minute is
 * legitimate and the cooldown is the only limit that should apply.
 */
function isScheduleRule(rule: UserRuleWithDetails): boolean {
  return rule.conditions.some((c) => c.condition_type === 'schedule');
}

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
      const contexts = await loadParamContexts(rules);
      // Schedules are the user's hours, not the server's — read once per pass and handed down to
      // every schedule condition. Null (never chosen) keeps the server's own zone, which is what
      // every schedule written before this did.
      const timeZone = await this.timeZoneOf(userId);
      if (contexts.size > 0) {
        log.debug(
          { userId, rules: rules.length, blueprintContexts: [...contexts.keys()] },
          'evaluating rules with blueprint parameter contexts',
        );
      }
      const now = new Date();
      for (const rule of rules) {
        if (!this.isCooldownExpired(rule)) continue;
        // A schedule matches a MINUTE and this scan runs every ten seconds, so a schedule rule
        // whose cooldown is shorter than a minute would fire six times on its minute. The cooldown
        // is the user's rate limit, not the mechanism that makes "at 06:00" mean once — this is.
        // Only schedule-bearing rules are held: a telemetry rule firing twice in a minute is
        // legitimate, and that is what the cooldown is for.
        if (isScheduleRule(rule) && firedThisMinute(rule.last_triggered, now)) continue;
        // A per-device rule (F11.2) resolves against its own binding's context — its own phase, its
        // own overrides — so the key is the pair, not the instance.
        const ctx =
          contexts.get(contextKey(rule.blueprint_instance_id, rule.blueprint_binding_id)) ??
          EMPTY_PARAM_CONTEXT;
        // Three gates, coarse first (F10.13, F11.3, then F10). A rule is held when its setup is not
        // running — a stopped setup does nothing at all, emergencies included — then when its own
        // bound device is not running, and finally when the rule's phase scope does not cover the
        // phase that device is in. Empty scope (every hand-written rule, and blueprint rules left
        // unscoped) is always in scope. All are read at evaluation time, so starting, stopping or
        // advancing changes what fires without touching a row.
        if (
          !isAutomationLive(
            rule.phase_scope,
            ctx.phase?.key ?? null,
            ctx.lifecycle,
            ctx.bindingLifecycle,
          )
        ) {
          log.debug(
            {
              rule: rule.name,
              scope: rule.phase_scope,
              phase: ctx.phase?.key ?? null,
              lifecycle: ctx.lifecycle,
              bindingLifecycle: ctx.bindingLifecycle,
            },
            !isInstanceRunning(ctx.lifecycle)
              ? 'rule skipped — its setup is not running'
              : !isInstanceRunning(ctx.bindingLifecycle)
                ? 'rule skipped — the device it belongs to is not running'
                : 'rule skipped — not active in the current phase',
          );
          continue;
        }
        const triggered = await this.evaluateRule(rule, ctx, timeZone);
        if (triggered) {
          // Claim the minute BEFORE acting, and let the database arbitrate. Two evaluators run
          // concurrently — the 10s schedule scan and the telemetry-driven pass — and both read
          // `last_triggered` before either writes it, so the in-memory guard above lets both
          // through and one firing dispatches twice. Observed live: two identical commands one
          // second apart. A conditional update is the only version only one of them can win.
          if (isScheduleRule(rule) && !(await this.claimMinute(rule, now))) {
            log.debug({ rule: rule.name }, 'rule skipped — another pass already fired this minute');
            continue;
          }
          await this.executeRule(ch, userId, rule, ctx);
          if (!isScheduleRule(rule)) {
            await db.userRule.update({
              where: { id: rule.id },
              data: { last_triggered: new Date(), updated_at: new Date() },
            });
          }
          this.notifyRuleFired(ch, userId, rule, areaById.get(rule.id) ?? null);
          await this.maybeAdvancePhase(ch, rule);
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

  /**
   * Take ownership of this clock minute, or lose the race.
   *
   * The `where` is the whole point: it matches only while `last_triggered` is still older than the
   * minute we are in, so of two concurrent passes exactly one updates a row and the other gets
   * count 0. The cheap in-memory check above still runs first — this is for the narrow window
   * where both passes read the same stale value, which is precisely when it matters.
   */
  private async claimMinute(rule: UserRuleWithDetails, now: Date): Promise<boolean> {
    const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const { count } = await db.userRule.updateMany({
      where: {
        id: rule.id,
        OR: [{ last_triggered: null }, { last_triggered: { lt: minuteStart } }],
      },
      data: { last_triggered: now, updated_at: now },
    });
    return count > 0;
  }

  /** The zone the owner's schedules are written in. Null = this process's own, the old behaviour. */
  private async timeZoneOf(userId: number): Promise<string | null> {
    try {
      const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
      return user?.timezone ?? null;
    } catch (err) {
      log.warn({ err, userId }, 'could not read user timezone — evaluating in the server zone');
      return null;
    }
  }

  // A blueprint phase may name a rule as what ends it (F11.x): when that rule fires, its owner
  // advances. The advance helper re-reads the owner's current phase and its `guard` confirms this
  // exact rule is still its decider, so a rule that fired for some other reason — or after the phase
  // already moved on — is a no-op. Per-device rules advance their own binding (one pot); setup-wide
  // rules advance the instance. A rule with no blueprint provenance can never be a phase decider.
  private async maybeAdvancePhase(ch: Channel, rule: UserRuleWithDetails): Promise<void> {
    if (rule.blueprint_instance_id == null || rule.blueprint_key == null) return;
    const guard = { mode: 'rule', refKey: rule.blueprint_key };
    try {
      if (rule.blueprint_binding_id != null) {
        await advanceBindingPhase(ch, rule.blueprint_binding_id, 'rule', guard);
      } else {
        await advanceSetupPhase(ch, rule.blueprint_instance_id, 'rule', guard);
      }
    } catch (err) {
      log.error({ err, rule: rule.name }, 'error advancing phase after rule fired');
    }
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

  private async evaluateRule(
    rule: UserRuleWithDetails,
    ctx: ParamContext,
    timeZone: string | null,
  ): Promise<boolean> {
    const results = await Promise.all(
      rule.conditions.map((c) => this.evaluateCondition(c, ctx, rule, timeZone)),
    );
    return rule.condition_operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  private async evaluateCondition(
    condition: UserRuleCondition,
    ctx: ParamContext,
    rule: UserRuleWithDetails,
    timeZone: string | null,
  ): Promise<boolean> {
    if (condition.condition_type === 'schedule') {
      // A window (until + every) makes this repeat inside its hours; without one it is the same
      // exact-minute match it always was. Evaluated in the OWNER's zone: "06:00" is a statement
      // about their morning, and this process runs in UTC.
      //
      // Either clock may be a reference since F11.14 — "lights off at @phase.light.off_time" is one
      // rule serving lifecycles that disagree about the hour. Resolved here rather than at load,
      // because the answer depends on the phase this entity is in right now. Fails closed: an
      // unresolvable time yields null, which matchesSchedule reads as never.
      const time = resolveClock(condition.schedule_time, ctx);
      if (condition.schedule_time && time === null) {
        log.warn(
          { rule: rule.name, schedule_time: condition.schedule_time },
          'rule schedule time references something unresolvable — condition treated as false',
        );
        return false;
      }
      return matchesSchedule(
        {
          time,
          until: resolveClock(condition.schedule_until, ctx),
          everyMinutes: condition.schedule_every_minutes,
          days: condition.schedule_days,
        },
        new Date(),
        timeZone,
      );
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
          // A rule's commands were the only ones with no id, so their acks correlated to nothing:
          // the device echoes this back and the command history settles the row with it.
          const commandId = randomUUID();
          // Resolved against the same context as the target (F11.14), so "water for
          // @phase.water.seconds" is one rule whose period follows whichever stage each device is
          // in. An unresolvable duration falls back to '*' (hold indefinitely) rather than dropping
          // the command: the state the rule asked for is still the right one, and a valve that
          // stays open is visible where a command that never arrived is not.
          const holdSeconds = resolveSeconds(ruleAction.duration_seconds, ctx);
          if (ruleAction.duration_seconds && holdSeconds === null) {
            log.warn(
              { rule: rule.name, duration_seconds: ruleAction.duration_seconds },
              'rule action duration unresolvable — dispatching without one (held indefinitely)',
            );
          }
          const payload: ActionDispatchPayload = {
            userId: String(userId),
            deviceId: String(uda.user_device_id),
            actionName: uda.mqtt_action_name,
            // The DEVICE holds the state for this long and releases it itself — its own timer
            // cannot be lost to a restart of this worker, which is what a second delayed OFF
            // action relied on. '*' means "hold indefinitely", the pre-duration behaviour.
            command: {
              value: target,
              duration: holdSeconds && holdSeconds > 0 ? String(holdSeconds) : '*',
              commandId,
            },
            commandId,
            firmwareVersion: uda.user_device.device.version ?? undefined,
            // The rule's name as it reads right now: history has to survive it being renamed.
            source: { kind: 'rule', refId: rule.id, label: rule.name },
            actionId: uda.id,
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

      // Null, zero and an unresolvable reference all mean "now" — the delay is a stagger, so the
      // safe reading of "I could not work out how long to wait" is not to wait.
      const delay = resolveSeconds(ruleAction.delay_seconds, ctx) ?? 0;
      if (delay > 0) {
        setTimeout(dispatch, delay * 1000);
      } else {
        await dispatch();
      }
    }
  }
}

export const rulesEngine = new RulesEngine();
