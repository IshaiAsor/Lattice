import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from './db/client';
import { valkey, keys } from './cache/valkey';
import { asString } from './util';
import { socket } from './socket/emitter';

const log = createLogger('digest-service:state-write');

export interface ScalarStateInput {
  userId:     string;
  deviceId:   string;
  actionName: string;
  value:      unknown;
  timestamp:  string;
}

// Authoritative write of a confirmed scalar state for a UserDeviceAction. Shared by the
// telemetry consumer (sensor readings) and the action-result consumer (device acks): both
// represent the device's true, observed state, so they persist identically. The DB write
// is authoritative (caller lets a throw nack → DLQ); history/cache/socket/rules are
// best-effort.
export async function writeScalarState(
  ch: Channel,
  userActionId: number,
  input: ScalarStateInput,
): Promise<void> {
  const { userId, deviceId, actionName, value, timestamp } = input;
  const stateValue = asString(value);

  log.info({ userActionId, userId, deviceId, actionName, value }, 'writing scalar state');
  // 1. Authoritative state write — failure nacks → DLQ.
  await db.userDeviceAction.update({
    where: { id: userActionId },
    data:  { current_state: stateValue, updated_at: new Date() },
  });

  // 2. Append to sensor history (best-effort).
  try {
    await db.sensorHistory.create({
      data: {
        user_device_action_id: userActionId,
        value:                 stateValue,
        recorded_at:           new Date(timestamp),
      },
    });
  } catch (err) {
    log.error({ err, userActionId }, 'sensor_history insert failed');
  }

  // 3. Hot cache (best-effort).
  try {
    await valkey.set(keys.actionState(userActionId), stateValue, 'EX', 3600);
  } catch (err) {
    log.error({ err, userActionId }, 'valkey action_state set failed');
  }

  // 4. Push to the UI (best-effort).
  try {
    socket.emitActionStateUpdate(parseInt(userId, 10), userActionId, value);
  } catch (err) {
    log.error({ err, userActionId }, 'socket emit failed');
  }

  // 5. Fan out to rules evaluation (best-effort).
  try {
    publish(ch, RK.RULES_EVALUATE, { userId, deviceId, actionName, value, timestamp });
  } catch (err) {
    log.error({ err, userActionId }, 'rules.evaluate publish failed');
  }
}
