import type { Channel } from 'amqplib';
import type { ActionResultPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { resolveUserDeviceAction } from '../resolve';
import { writeScalarState } from '../state-write';
import { socket } from '../socket/emitter';
import { takePending } from '../cache/pending';
import type { PendingCommand } from '../cache/pending';
import * as timeout from '../pending-timeout';
import { db } from '../db/client';

const log = createLogger('digest-service:action-result');

// A device's acknowledgement that it executed (or rejected) a command. This is the ONLY
// path that writes current_state for command actions — the request side merely dispatches
// and waits. On 'ok' we persist the device's reported state authoritatively (same writer
// as telemetry). The commandId, when present, resolves the in-flight pending request and
// clears its timeout; acks without a commandId are unsolicited state reports the device
// makes on its own (duration auto-off, boot restore) and still update state.
export function actionResultConsumer(ch: Channel) {
  return async (payload: ActionResultPayload): Promise<void> => {
    const { userId, deviceId, actionName, commandId, status, value, timestamp } = payload;
    log.info({ userId, deviceId, actionName, commandId, status }, 'action.result received');

    // Settle the in-flight request (if any). takePending races the timeout via GETDEL;
    // whoever wins resolves the UI. Always clear the local timer regardless.
    let pending: PendingCommand | null = null;
    if (commandId) {
      timeout.clear(commandId);
      pending = await takePending(commandId);
    }

    if (status === 'error') {
      // OTA failure — rollback staged actions and restore old ones.
      if (actionName === 'ota') {
        const userDeviceId = parseInt(deviceId, 10);
        await db.$transaction([
          db.userDeviceAction.deleteMany({
            where: { user_device_id: userDeviceId, status: 'staged_active' },
          }),
          db.userDeviceAction.updateMany({
            where: { user_device_id: userDeviceId, status: 'staged_deprecated' },
            data: { status: 'active' },
          }),
          db.userDevice.update({
            where: { id: userDeviceId },
            data: { pending_firmware_version: null, pending_device_type_id: null },
          }),
        ]);
        log.warn({ userDeviceId, value }, 'OTA failed — staged actions removed, old actions restored');
        return;
      }

      // Rejected by the device — no DB write. Revert the UI if we owned the pending request.
      if (pending !== null && commandId) {
        log.warn({ userId, deviceId, actionName, commandId }, 'device rejected command → failed');
        socket.emitActionStateFailed(parseInt(userId, 10), pending.actionId, commandId);
      }
      return;
    }

    // status === 'ok' → write the device's observed state authoritatively.
    const resolved = await resolveUserDeviceAction(deviceId, actionName);
    if (resolved === null) {
      // Unknown device/action — throw so the message nacks → DLQ for visibility.
      log.error({ userId, deviceId, actionName }, 'unresolved ack action → DLQ');
      throw new Error(`unresolved action ${deviceId}/${actionName}`);
    }

    await writeScalarState(ch, resolved.id, { userId, deviceId, actionName, value, timestamp, commandId });
    log.info({ userId, deviceId, actionName, commandId }, 'action result processed — state updated');
  };
}
