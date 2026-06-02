import { userRulesRepository, UserRuleWithDetails } from '../dal/user.rules.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { userDevicesRepository } from '../dal/user.devices.repository';
import mqttService, { MqttChannel } from './mqtt.service';
import socketService from './socket.service';

type ScheduleParams = { time?: string; days?: number[] };
type StateParams = { user_device_action_id?: number; operator?: string; value?: string };
type DeviceStatusParams = { user_device_id?: number; status?: string };

class RulesEngineService {

  async evaluateForUser(userId: number): Promise<void> {
    try {
      const rules = await userRulesRepository.getEnabledByUserId(userId);
      for (const rule of rules) {
        if (!this.isCooldownExpired(rule)) continue;
        const triggered = await this.evaluateRule(rule);
        if (triggered) {
          await this.executeRule(userId, rule);
          await userRulesRepository.updateLastTriggered(rule.id);
        }
      }
    } catch (err) {
      console.error('[RulesEngine] Error evaluating rules for user', userId, err);
    }
  }

  async evaluateScheduledRules(): Promise<void> {
    try {
      const userIds = await userRulesRepository.getUserIdsWithScheduledRules();
      for (const userId of userIds) {
        await this.evaluateForUser(userId);
      }
    } catch (err) {
      console.error('[RulesEngine] Error evaluating scheduled rules:', err);
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

  private async evaluateCondition(condition: { condition_type: string; parameters: unknown }): Promise<boolean> {
    const params = condition.parameters as StateParams & ScheduleParams;

    if (condition.condition_type === 'schedule') {
      return this.matchesScheduleNow(params);
    }

    if (condition.condition_type === 'device_state' || condition.condition_type === 'device_status') {
      const p = params as unknown as DeviceStatusParams;
      const deviceId = p.user_device_id ?? (params as any).user_device_id;
      const expected = p.status ?? (params as any).value;
      if (!deviceId || !expected) return false;
      try {
        const device = await userDevicesRepository.getById(deviceId);
        return expected === 'online' ? !!device.online : !device.online;
      } catch {
        return false;
      }
    }

    if (!params.user_device_action_id || !params.operator || params.value === undefined) return false;

    const action = await userDevicesActionsRepository.getById(params.user_device_action_id);
    if (!action) return false;

    const currentState = action.current_state ?? '';

    // threshold: numeric comparison
    if (condition.condition_type === 'threshold') {
      const current = parseFloat(currentState);
      const target = parseFloat(params.value);
      if (isNaN(current) || isNaN(target)) return false;
      return this.compare(current, params.operator, target);
    }

    return false;
  }

  private matchesScheduleNow(params: ScheduleParams): boolean {
    if (!params.time) return false;
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    const currentTime = `${hh}:${mm}`;
    if (currentTime !== params.time) return false;
    if (!params.days || params.days.length === 0) return true;
    return params.days.includes(now.getDay());
  }

  private compare(a: number, op: string, b: number): boolean {
    switch (op) {
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
      case '=': return a === b;
      case '!=': return a !== b;
      default: return false;
    }
  }

  private compareStrings(a: string, op: string, b: string): boolean {
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      default: return false;
    }
  }

  private async executeRule(userId: number, rule: UserRuleWithDetails): Promise<void> {
    for (const ruleAction of rule.actions) {
      const execute = async () => {
        try {
          const userDeviceAction = await userDevicesActionsRepository.getById(ruleAction.user_device_action_id);
          if (!userDeviceAction) return;

          const state = ruleAction.target_state;
          const deviceId = userDeviceAction.user_device_id;
          const actionType = (userDeviceAction.action.mqtt_action_type ?? 'command') as MqttChannel;
          const actionName = userDeviceAction.action.mqtt_action_name ?? '';

          await userDevicesActionsRepository.updateState(ruleAction.user_device_action_id, state);
          mqttService.publish(userId, deviceId, actionType, actionName, state);
          socketService.publishActionStateUpdate(userId, ruleAction.user_device_action_id, state);

          console.log(`[RulesEngine] Rule "${rule.name}" fired: set action ${ruleAction.user_device_action_id} to "${state}"`);
        } catch (err) {
          console.error(`[RulesEngine] Error executing action for rule "${rule.name}":`, err);
        }
      };

      if (ruleAction.delay_seconds > 0) {
        setTimeout(execute, ruleAction.delay_seconds * 1000);
      } else {
        await execute();
      }
    }
  }
}

export const rulesEngineService = new RulesEngineService();
