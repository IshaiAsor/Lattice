import { createLogger } from '@lattice/logger';
import { db } from './db/client';

const log = createLogger('digest-service:ota-confirm');

/**
 * Settle a pending OTA against the version a device reports it is actually running.
 *
 * A device proves an update landed by talking to us from the new version's topic path — its
 * status publish on reconnect, or any ack. Both are the same evidence, so both funnel here
 * rather than only the status path: an OTA that is confirmed by exactly one message is an
 * OTA that a lost or out-of-order message strands forever (see `rejected:not-newer` in
 * action-result.consumer).
 *
 * Confirming flips the staged action set live and repoints the device at the new catalog
 * row. That repoint is what keeps the device addressable: every command dispatcher builds
 * its MQTT topic from `devices.version`, so a device left on the old catalog row is
 * published at on a topic it no longer subscribes to — online, heartbeating, and deaf.
 *
 * Idempotent and safe to call on every status/ack: it is a no-op unless there is a pending
 * OTA whose version matches what the device reports.
 */
export async function confirmOtaIfPending(
  userDeviceId: number,
  reportedVersion: string,
): Promise<boolean> {
  const userDevice = await db.userDevice.findUnique({
    where: { id: userDeviceId },
    select: { pending_firmware_version: true, pending_device_type_id: true },
  });

  if (
    userDevice == null ||
    userDevice.pending_firmware_version !== reportedVersion ||
    userDevice.pending_device_type_id == null
  ) {
    return false;
  }

  const pendingDeviceTypeId = userDevice.pending_device_type_id;
  await db.$transaction([
    db.userDeviceAction.updateMany({
      where: { user_device_id: userDeviceId, status: 'staged_active' },
      data: { status: 'active' },
    }),
    db.userDeviceAction.updateMany({
      where: { user_device_id: userDeviceId, status: 'staged_deprecated' },
      data: { status: 'deprecated' },
    }),
    db.userDevice.update({
      where: { id: userDeviceId },
      data: {
        current_firmware_version: reportedVersion,
        device_type_id: pendingDeviceTypeId,
        pending_firmware_version: null,
        pending_device_type_id: null,
      },
    }),
  ]);

  log.info(
    { userDeviceId, version: reportedVersion },
    'OTA confirmed — actions activated, firmware version updated',
  );
  return true;
}
