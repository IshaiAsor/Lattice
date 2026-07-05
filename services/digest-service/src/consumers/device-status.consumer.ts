import type { DeviceStateChangedPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { socket } from '../socket/emitter';

const log = createLogger('digest-service:device-status');

// Heartbeat-length TTL: an online key auto-expires if the device stops reporting
// without sending a clean offline (e.g. power loss). Keep aligned with the device
// status publish interval.
const ONLINE_TTL_SECONDS = 90;

export function deviceStatusConsumer() {
  return async (payload: DeviceStateChangedPayload): Promise<void> => {
    const { userId, deviceId, state, timestamp, version } = payload;
    const online = state === true;
    const userDeviceId = parseInt(deviceId, 10);

    log.info({ userId, deviceId, online }, 'device.status received');
    // 1. Authoritative liveness write — failure nacks → DLQ.
    await db.userDevice.update({
      where: { id: userDeviceId },
      data: { online, last_online_date: new Date(timestamp) },
    });

    // 2. OTA confirmation: device reconnected on the expected new-version topic path.
    if (online && version) {
      const userDevice = await db.userDevice.findUnique({
        where: { id: userDeviceId },
        select: { pending_firmware_version: true, pending_device_type_id: true },
      });
      if (
        userDevice != null &&
        userDevice.pending_firmware_version === version &&
        userDevice.pending_device_type_id != null
      ) {
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
              current_firmware_version: version,
              device_type_id: pendingDeviceTypeId,
              pending_firmware_version: null,
              pending_device_type_id: null,
            },
          }),
        ]);
        log.info({ userDeviceId, version }, 'OTA confirmed — actions activated, firmware version updated');
      }
    }

    // 2. Hot cache (best-effort).
    try {
      if (online) {
        await valkey.set(keys.deviceOnline(userDeviceId), '1', 'EX', ONLINE_TTL_SECONDS);
      } else {
        await valkey.del(keys.deviceOnline(userDeviceId));
      }
    } catch (err) {
      log.error({ err, userDeviceId }, 'valkey device_online write failed');
    }

    // 3. Push to the UI (best-effort).
    try {
      socket.emitDeviceStatusChange(parseInt(userId, 10), userDeviceId, online);
    } catch (err) {
      log.error({ err, userDeviceId }, 'socket emit failed');
    }

    log.info({ userDeviceId, online }, 'device status processed');
  };
}
