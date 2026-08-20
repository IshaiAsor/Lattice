import type { Channel } from 'amqplib';
import type { ActionResultPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { resolveUserDeviceAction } from '../resolve';
import { writeScalarState, reconcileState } from '../state-write';
import { socket } from '../socket/emitter';
import { takePending, takePendingRead } from '../cache/pending';
import type { PendingCommand, PendingRead } from '../cache/pending';
import { reconcileDivergences } from '../metrics';
import * as timeout from '../pending-timeout';
import { recordAck } from '../command-history';
import { db } from '../db/client';
import { confirmOtaIfPending } from '../ota-confirm';
import { recordReportedVersion } from '../device-version';

const log = createLogger('digest-service:action-result');

// A device's acknowledgement that it executed (or rejected) a command. This is the ONLY
// path that writes current_state for command actions — the request side merely dispatches
// and waits. On 'ok' we persist the device's reported state authoritatively (same writer
// as telemetry). The commandId, when present, resolves the in-flight pending request and
// clears its timeout; acks without a commandId are unsolicited state reports the device
// makes on its own (duration auto-off, boot restore) and still update state.
export function actionResultConsumer(ch: Channel) {
  return async (payload: ActionResultPayload): Promise<void> => {
    const { userId, deviceId, actionName, commandId, status, value, timestamp, version } = payload;
    log.info({ userId, deviceId, actionName, commandId, status }, 'action.result received');

    // Settle the in-flight request (if any). takePending races the timeout via GETDEL;
    // whoever wins resolves the UI. Always clear the local timer regardless.
    let pending: PendingCommand | null = null;
    if (commandId) {
      timeout.clear(commandId);
      pending = await takePending(commandId);
    }

    // Is this the answer to a read-back rather than to a command? Taken before recordAck, which
    // has no row to settle for a read and would otherwise invent one (F23.1).
    let pendingRead: PendingRead | null = null;
    if (commandId) pendingRead = await takePendingRead(commandId);

    // The durable half of the same settlement (F11.12), and the only record of an ack that has no
    // command behind it — a duration releasing, or a boot restore. Written before the branches
    // below because an error ack returns early, and "the device refused" is worth keeping.
    await recordAck(payload);

    // An ack is published on `.../{version}/ack/...`, so it carries the version the device is
    // actually running (F3.16). Recorded here, above every branch below, because the error and
    // `not-newer` paths both return early — and `not-newer` in particular is a device telling us
    // outright that it runs something other than what we offered, which is precisely when our
    // record is most likely to be wrong.
    await recordReportedVersion(parseInt(deviceId, 10), version, 'ack');

    if (status === 'error') {
      // OTA failure — rollback staged actions and restore old ones.
      if (actionName === 'ota') {
        const userDeviceId = parseInt(deviceId, 10);
        const detail = typeof value === 'string' ? value : '';

        // `not-newer` is the device reporting it ALREADY runs what we offered — the opposite
        // of a failed update. Treating it as a failure is what stranded devices whose update
        // had in fact landed: it clears pending_firmware_version, so the confirming status
        // message can never settle the OTA, and the device stays pinned to the old catalog
        // row — addressed on a command topic it no longer subscribes to. Settle from the
        // version the device reports instead of rolling back.
        if (detail.startsWith('rejected:not-newer')) {
          const confirmed = version != null && (await confirmOtaIfPending(userDeviceId, version));
          log.info(
            { userDeviceId, version, confirmed },
            'device already runs the offered firmware — not an OTA failure',
          );
          return;
        }

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
            data: {
              pending_firmware_version: null,
              pending_device_type_id: null,
              pending_since: null,
            },
          }),
        ]);
        log.warn(
          { userDeviceId, value },
          'OTA failed — staged actions removed, old actions restored',
        );
        // The device is still on the old firmware and still connected, so nothing else will
        // tell the page this ended — it would sit on "Updating…" until reloaded, which is how
        // a failed update reads as a hung one and gets pressed again.
        try {
          socket.emitDeviceUpdateState(
            parseInt(userId, 10),
            userDeviceId,
            'failed',
            null,
            detail || undefined,
          );
        } catch (err) {
          log.warn({ err, userDeviceId }, 'OTA failure socket emit failed');
        }
        return;
      }

      // Rejected by the device — no DB write. Revert the UI if we owned the pending request.
      if (pending !== null && commandId) {
        log.warn({ userId, deviceId, actionName, commandId }, 'device rejected command → failed');
        socket.emitActionStateFailed(parseInt(userId, 10), pending.actionId, commandId);
      }
      return;
    }

    // OTA is not a device action — nothing resolves `ota` to a UserDeviceAction, so without this
    // the generic path below throws and dead-letters every OTA progress ack the device sends.
    // There is no state to write either: an OTA settles when the device reports the new version,
    // and an ack arriving from the new version's topic path is itself that evidence.
    if (actionName === 'ota') {
      if (version) await confirmOtaIfPending(parseInt(deviceId, 10), version);
      log.info({ userId, deviceId, value, version }, 'OTA progress ack');
      return;
    }

    // A read-back answers with the device's own state rather than the result of a command, so it
    // takes the divergence path: confirm quietly, or correct loudly (F23.3b).
    //
    // Addressed by the id the read was ISSUED for, never by re-resolving (deviceId, actionName).
    // That pair is not unique — a device can carry several rows sharing one mqtt name (a
    // re-provision leaves the old instance behind), and the resolver returns whichever it finds.
    // Re-resolving would compare this row's expectedState against a different row and write the
    // correction there: seen for real on the dev stack, where a read of action 51 corrected 84.
    if (pendingRead !== null) {
      const diverged = await reconcileState(ch, pendingRead.actionId, {
        userId,
        deviceId,
        actionName,
        value,
        timestamp,
        expectedState: pendingRead.expectedState,
      });
      if (diverged) reconcileDivergences.add(1, { reason: pendingRead.reason });
      return;
    }

    // status === 'ok' → write the device's observed state authoritatively.
    const resolved = await resolveUserDeviceAction(deviceId, actionName);
    if (resolved === null) {
      // Unknown device/action — throw so the message nacks → DLQ for visibility.
      log.error({ userId, deviceId, actionName }, 'unresolved ack action → DLQ');
      throw new Error(`unresolved action ${deviceId}/${actionName}`);
    }

    await writeScalarState(ch, resolved.id, {
      userId,
      deviceId,
      actionName,
      value,
      timestamp,
      commandId,
      // An ack with no commandId is unsolicited: the device volunteering state after a reboot or
      // a duration releasing itself, rather than answering anything we asked.
      source: commandId ? 'command-ack' : 'boot-restore',
    });
    log.info(
      { userId, deviceId, actionName, commandId },
      'action result processed — state updated',
    );
  };
}
