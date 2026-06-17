import { emergencyRepository } from '../dal/emergency.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { actionHubService } from './action.hub.service';

class EmergencyService {
  async checkEmergency(userId: number, actionId: number, value: string): Promise<void> {
    const rules = await emergencyRepository.getEnabledByActionId(actionId);
    if (rules.length === 0) return;

    const numericValue = parseFloat(value);

    for (const rule of rules) {
      const threshold = parseFloat(rule.threshold_value);
      const triggered = isNaN(numericValue) || isNaN(threshold)
        ? value === rule.threshold_value
        : this.compare(numericValue, rule.operator, threshold);

      if (!triggered) continue;

      emergencyRepository.logEvent(rule.id, value).catch(err =>
        console.error('[Emergency] Failed to log event:', err)
      );

      if (rule.target_action_id && rule.target_state) {
        actionHubService.dispatch(userId, rule.target_action_id, rule.target_state, 'rules', {
          skipRulesEval: true,
        }).catch(err => console.error('[Emergency] Failed to dispatch action:', err));
      }

      // TODO(F9): emergency_alert real-time notification — re-land in the emergency
      // service/worker. The old Socket.IO emit was removed with the monolith ws strip.

      console.log(`🚨 [Emergency] Rule "${rule.name}" triggered: value=${value} ${rule.operator} threshold=${rule.threshold_value}`);
    }
  }

  private compare(a: number, op: string, b: number): boolean {
    switch (op) {
      case '>':  return a > b;
      case '<':  return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
      case '=':  return a === b;
      case '!=': return a !== b;
      default:   return false;
    }
  }
}

export const emergencyService = new EmergencyService();
