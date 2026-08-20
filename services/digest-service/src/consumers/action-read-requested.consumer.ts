import type { Channel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { publish, RK } from '@lattice/queue';
import type { ActionReadRequestedPayload, ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { setPendingRead, takePendingRead } from '../cache/pending';
import { env } from '../config/env.config';
import { reconcileReadsIssued, reconcileReadsUnanswered } from '../metrics';
import { READ_COMMAND_PREFIX } from '../read-command';
import * as timeout from '../pending-timeout';

const log = createLogger('digest-service:action-read-requested');

// Ask a device what state it is actually in. The inverse of actionRequestedConsumer: same
// resolve → dispatch → arm-timeout shape, but it carries no intent and writes no optimistic
// state. The device answers on the ack topic with its NVS-persisted value and the ack consumer
// decides whether that confirms the stored state or corrects it (F23.3b).
//
// Deliberately NOT recorded in device_commands: a read has no target_state, so a history row for
// it would describe a command that never happened. Both halves of that exclusion live elsewhere —
// `readback: true` on the dispatch (skipped by recordDispatch) and the commandId prefix above
// (skipped by recordAck).
export function actionReadRequestedConsumer(ch: Channel) {
  return async (payload: ActionReadRequestedPayload): Promise<void> => {
    const { userId, actionId, reason } = payload;

    const row = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        user_device_id: true,
        mqtt_action_name: true,
        current_state: true,
        user_device: {
          select: { current_firmware_version: true, device: { select: { version: true } } },
        },
      },
    });
    if (!row) {
      // Unknown action — throw so the message nacks → DLQ for visibility, matching every other
      // digest consumer.
      log.error({ userId, actionId }, 'unresolved action on read request → DLQ');
      throw new Error(`unresolved action ${actionId}`);
    }

    const deviceId = String(row.user_device_id);
    const actionName = row.mqtt_action_name;
    const commandId = `${READ_COMMAND_PREFIX}${randomUUID()}`;
    const timeoutMs = env.actionReadTimeoutMs;

    // Record what the DB believes NOW, not at ack time: the comparison must be against the value
    // the read was asked about, or a command landing in between would read as a divergence.
    const ttlSeconds = Math.ceil(timeoutMs / 1000) + 30;
    try {
      await setPendingRead(
        commandId,
        { userId, actionId, deviceId, actionName, expectedState: row.current_state, reason },
        ttlSeconds,
      );
    } catch (err) {
      log.error({ err, actionId, commandId }, 'pending read set failed');
    }

    // The `read` verb rides the ordinary dispatch path — mqtt-service publishes payload.command
    // verbatim to .../command/{actionName}, and the firmware selects the verb from the BODY,
    // intercepting it before validateActionPayload. So there is no new topic and no new contract.
    const dispatch: ActionDispatchPayload = {
      userId,
      deviceId,
      actionName,
      command: { value: 'read', commandId },
      commandId,
      // Address the version the device actually booted, not the catalog row — otherwise this
      // publishes to a topic nothing subscribes to.
      firmwareVersion: row.user_device.current_firmware_version ?? row.user_device.device.version,
      actionId,
      readback: true,
    };
    try {
      publish(ch, RK.ACTION_DISPATCH, dispatch);
      reconcileReadsIssued.add(1, { reason });
      log.debug({ actionId, commandId, deviceId, reason }, 'state read dispatched to device');
    } catch (err) {
      log.error({ err, actionId }, 'state read dispatch publish failed');
    }

    // Arm the no-response timeout. takePendingRead is the arbiter: if the ack already resolved
    // the read, the record is gone and there is nothing to report.
    //
    // Note it does NOT call recordTimeout — that settles a device_commands row, and a read has
    // none by design. An unanswered read is a metric, not history.
    timeout.arm(commandId, timeoutMs, () => {
      takePendingRead(commandId)
        .then((pending) => {
          if (pending === null) return; // already answered
          reconcileReadsUnanswered.add(1, { reason });
          log.warn(
            { actionId, commandId, deviceId, reason },
            'state read timed out with no ack — state remains unconfirmed',
          );
        })
        .catch((err) => log.error({ err, commandId }, 'pending read timeout resolution failed'));
    });
  };
}
