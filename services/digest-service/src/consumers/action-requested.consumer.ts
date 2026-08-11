import { randomUUID } from 'node:crypto';
import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionRequestedPayload, ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { deriveValidParameters, validateValue } from '@lattice/capability-validation';
import { db } from '../db/client';
import { asString } from '../util';
import { socket } from '../socket/emitter';
import { env } from '../config/env.config';
import { setPending, takePending } from '../cache/pending';
import { recordTimeout } from '../command-history';
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
    log.info(
      { userId, actionId, value, duration, source: payload.source?.kind },
      'action.requested received',
    );

    const row = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        current_state: true,
        user_device_id: true,
        mqtt_action_name: true,
        user_device: { select: { device: { select: { version: true } } } },
        capability: {
          select: { traits: { select: { google_trait: { select: { valid_parameters: true } } } } },
        },
      },
    });
    if (!row) {
      // Unknown action — throw so the message nacks → DLQ for visibility.
      log.error({ userId, actionId }, 'unresolved action on request → DLQ');
      throw new Error(`unresolved action ${actionId}`);
    }

    const stateValue = asString(value);
    const deviceId = String(row.user_device_id);
    const commandId = randomUUID();

    // A value outside the capability's declared constraint is expected user/UI error, not an
    // infra fault — reject it directly to the requesting client instead of dispatching or
    // routing to the DLQ.
    const validParameters = deriveValidParameters(
      row.capability.traits.map((t) => t.google_trait.valid_parameters),
    );
    if (!validateValue(stateValue, validParameters)) {
      log.warn(
        { userId, actionId, value },
        'action.requested rejected — value outside valid_parameters',
      );
      socket.emitActionStateFailed(parseInt(userId, 10), actionId, commandId, row.current_state);
      return;
    }

    // 1. Record the in-flight command so the ack / timeout can resolve it. TTL outlives the
    //    ack timeout so a crash can't leak the key.
    const ttlSeconds = Math.ceil(env.actionAckTimeoutMs / 1000) + 30;
    try {
      await setPending(
        commandId,
        { userId, actionId, deviceId, actionName: row.mqtt_action_name, value },
        ttlSeconds,
      );
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
      actionName: row.mqtt_action_name,
      command: { value: stateValue, duration: duration ?? '*', commandId },
      commandId,
      firmwareVersion: row.user_device.device.version,
      // Carried through for the command history: who asked for this, and which action it is. A
      // request with no source is a manual one — the dashboard is the only path that omits it.
      source: payload.source ?? { kind: 'manual' },
      actionId,
    };
    try {
      publish(ch, RK.ACTION_DISPATCH, dispatch);
      log.info({ actionId, commandId, deviceId }, 'command dispatched to device');
    } catch (err) {
      log.error({ err, actionId }, 'action.dispatch publish failed');
    }

    // 4. Arm the no-ack timeout. takePending is the arbiter: if the ack already resolved the
    //    command, the record is gone and we do nothing; otherwise we mark it failed.
    timeout.arm(commandId, env.actionAckTimeoutMs, () => {
      takePending(commandId)
        .then(async (pending) => {
          if (pending === null) return; // already acked
          log.warn({ actionId, commandId }, 'command timed out with no device ack → failed');
          socket.emitActionStateFailed(
            parseInt(userId, 10),
            actionId,
            commandId,
            row.current_state,
          );
          // Same verdict, made durable — otherwise the row would sit "sent" forever and read as
          // "no ack seen yet" long after we stopped waiting for one.
          await recordTimeout(commandId);
        })
        .catch((err) => log.error({ err, commandId }, 'pending timeout resolution failed'));
    });
  };
}
