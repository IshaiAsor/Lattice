import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionRequestedPayload, ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { asString } from '../util';
import { socket } from '../socket/emitter';

const log = createLogger('digest-service:action-requested');

// A UI client (via socket-server) requests an action state change by UserDeviceAction
// id. digest owns the DB + cache + socket, so it resolves the id to device/version/mqtt
// name, optimistically writes current_state, echoes action_state_update (after the
// write), then publishes the concrete ACTION_DISPATCH for mqtt-service → device. The
// device's telemetry later reconciles the actual state via the telemetry consumer.
export function actionRequestedConsumer(ch: Channel) {
  return async (payload: ActionRequestedPayload): Promise<void> => {
    const { userId, actionId, value, duration } = payload;

    const row = await db.userDeviceAction.findUnique({
      where:  { id: actionId },
      select: {
        user_device_id:   true,
        mqtt_action_name: true,
        user_device: { select: { device: { select: { version: true } } } },
      },
    });
    if (!row) {
      // Unknown action — throw so the message nacks → DLQ for visibility.
      log.error({ userId, actionId }, 'unresolved action on request → DLQ');
      throw new Error(`unresolved action ${actionId}`);
    }

    const stateValue = asString(value);

    // 1. Optimistic state write — failure nacks → DLQ.
    await db.userDeviceAction.update({
      where: { id: actionId },
      data:  { current_state: stateValue, updated_at: new Date() },
    });

    // 2. Hot cache (best-effort).
    try {
      await valkey.set(keys.actionState(actionId), stateValue, 'EX', 3600);
    } catch (err) {
      log.error({ err, actionId }, 'valkey action_state set failed');
    }

    // 3. Echo to the user's clients — after the DB write (best-effort).
    try {
      socket.emitActionStateUpdate(parseInt(userId, 10), actionId, value);
    } catch (err) {
      log.error({ err, actionId }, 'socket emit failed');
    }

    // 4. Dispatch the concrete command to the device. The MQTT body matches the legacy
    // contract ({ value, duration }) so firmware is unchanged.
    const dispatch: ActionDispatchPayload = {
      userId,
      deviceId:        String(row.user_device_id),
      actionName:      row.mqtt_action_name,
      command:         { value: stateValue, duration: duration ?? '*' },
      firmwareVersion: row.user_device.device.version,
    };
    try {
      publish(ch, RK.ACTION_DISPATCH, dispatch);
    } catch (err) {
      log.error({ err, actionId }, 'action.dispatch publish failed');
    }
  };
}
