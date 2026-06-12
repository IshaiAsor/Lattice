import { emergencyCache } from '../dal/emergency.cache';
import { deviceCache } from '../dal/device.cache';
import { deviceGatewayRepository } from '../dal/device.gateway.repository';
import { socketEmitter } from './socket.emitter.service';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import type { EmergencyRule } from '@lattice/prisma-client';

const log = createLogger('device-gateway:emergency');

function evaluate(operator: string, value: number, threshold: number): boolean {
  switch (operator) {
    case '>':  return value >  threshold;
    case '<':  return value <  threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '=':
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default:   return false;
  }
}

async function dispatchTarget(rule: EmergencyRule, userId: number, traceId?: string): Promise<void> {
  if (!rule.target_user_action_id && !rule.target_capability) return;

  if (rule.target_scope === 'instance' && rule.target_user_action_id) {
    // Find the target action's device + MQTT info
    const action = await deviceCache.resolveAction(0, '').catch(() => null);
    // Simplified: publish action.dispatch so device-gateway's own consumer handles it
    await publish(RK.actionDispatch(userId), {
      userId,
      userDeviceId: 0,               // will be resolved by the consumer
      mqttType: 'command',
      mqttName: String(rule.target_user_action_id),
      value: rule.target_state ?? '1',
      traceId,
    });
  } else if (rule.target_scope === 'capability' && rule.target_capability) {
    await publish(RK.actionDispatch(userId), {
      userId,
      userDeviceId: 0,
      mqttType: 'capability',
      mqttName: rule.target_capability,
      value: rule.target_state ?? '1',
      traceId,
    });
  }
}

export async function checkEmergency(
  userId: number,
  actionId: number,
  capability: string,
  value: string,
  traceId?: string,
): Promise<void> {
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return; // only numeric values trigger threshold rules

  let rules: EmergencyRule[];
  try {
    rules = await emergencyCache.getMatchingRules(userId, actionId, capability);
  } catch (err) {
    log.error(err, 'Failed to load emergency rules from cache');
    return;
  }

  for (const rule of rules) {
    const threshold = parseFloat(rule.threshold);
    if (isNaN(threshold)) continue;

    if (!evaluate(rule.operator, numValue, threshold)) continue;

    log.warn({ ruleId: rule.id, value, threshold: rule.threshold, operator: rule.operator }, 'emergency rule triggered');

    // Emit socket alert (sync, non-blocking for caller)
    socketEmitter.emitEmergencyAlert(userId, {
      ruleId:    rule.id,
      ruleName:  rule.name,
      actionId,
      value,
      timestamp: new Date().toISOString(),
    });

    // Async: log event to DB (fire-and-forget)
    deviceGatewayRepository.logEmergencyEvent(rule.id, value, traceId).catch((err) =>
      log.error(err, 'Failed to log emergency event'),
    );

    // Dispatch target action via RabbitMQ (async)
    dispatchTarget(rule, userId, traceId).catch((err) =>
      log.error(err, 'Failed to dispatch emergency target'),
    );
  }
}
