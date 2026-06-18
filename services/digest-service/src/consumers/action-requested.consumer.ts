import { randomUUID } from 'node:crypto';
import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionRequestedPayload, ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { asString } from '../util';
import { socket } from '../socket/emitter';
import { env } from '../config/env.config';
import { setPending, takePending } from '../cache/pending';
import * as timeout from '../pending-timeout';

const log = createLogger('digest-service:action-requested');

// A UI client (via socket-server) requests an action state change by UserDeviceAction id.
// digest resolves the id to device/version/mqtt name and dispatches the concrete command —
// but it does NOT write current_state here. The DB is the device's observed truth: state
// is written only when the device acks (action-result consumer). Until then the request is
// tracked as a pending command (Valkey, keyed by commandId) and the UI shows it as pending.
// A timeout marks it failed if the device never confirms.
export function actionRequestedConsumer(ch: Channel) {
  return async (payload: ActionRequestedPayload): Promise<void> => {
    const { userId, actionId, value, duration } = payload;

    const row = await db.userDeviceAction.findUnique({
      where:  { id: actionId },
      select: {
        current_state:   true,
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
    const deviceId   = String(row.user_device_id);
    const commandId  = randomUUID();

    // 1. Record the in-flight command so the ack / timeout can resolve it. TTL outlives the
    //    ack timeout so a crash can't leak the key.
    const ttlSeconds = Math.ceil(env.actionAckTimeoutMs / 1000) + 30;
    try {
      await setPending(commandId, { userId, actionId, deviceId, actionName: row.mqtt_action_name, value }, ttlSeconds);
    } catch (err) {
      log.error({ err, actionId, commandId }, 'pending command set failed');
    }

    // 2. Tell the UI the change is pending (no DB write yet).
    try {
      socket.emitActionStatePending(parseInt(userId, 10), actionId, commandId, value);
    } catch (err) {
      log.error({ err, actionId }, 'socket pending emit failed');
    }

    // 3. Dispatch the concrete command to the device. commandId rides inside the command
    //    body so the device can echo it back on its ack; { value, duration } is unchanged.
    const dispatch: ActionDispatchPayload = {
      userId,
      deviceId,
      actionName:      row.mqtt_action_name,
      command:         { value: stateValue, duration: duration ?? '*', commandId },
      commandId,
      firmwareVersion: row.user_device.device.version,
    };
    try {
      publish(ch, RK.ACTION_DISPATCH, dispatch);
      log.info({ actionId, commandId }, 'action.dispatch published');
    } catch (err) {
      log.error({ err, actionId }, 'action.dispatch publish failed');
    }

    // 4. Arm the no-ack timeout. takePending is the arbiter: if the ack already resolved the
    //    command, the record is gone and we do nothing; otherwise we mark it failed.
    timeout.arm(commandId, env.actionAckTimeoutMs, () => {
      takePending(commandId)
        .then((pending) => {
          if (pending === null) return; // already acked
          log.warn({ actionId, commandId }, 'command timed out with no device ack → failed');
          socket.emitActionStateFailed(parseInt(userId, 10), actionId, commandId, row.current_state);
        })
        .catch((err) => log.error({ err, commandId }, 'pending timeout resolution failed'));
    });
  };
}
