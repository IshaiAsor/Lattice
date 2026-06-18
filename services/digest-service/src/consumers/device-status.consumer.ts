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
    const { userId, deviceId, state, timestamp } = payload;
    const online = state === true;
    const userDeviceId = parseInt(deviceId, 10);

    log.trace({ userId, deviceId, online }, 'device.status received');
    // 1. Authoritative liveness write — failure nacks → DLQ.
    await db.userDevice.update({
      where: { id: userDeviceId },
      data: { online, last_online_date: new Date(timestamp) },
    });

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
  };
}
