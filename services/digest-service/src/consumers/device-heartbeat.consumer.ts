import type { DeviceHeartbeatPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { socket } from '../socket/emitter';

const log = createLogger('digest-service:device-heartbeat');

// TTL spans a few missed heartbeats so a single dropped ping doesn't flap liveness, but the
// key still expires promptly after a device goes dark. Firmware pings every 60s
// (HEARTBEAT_INTERVAL_MS), so ~3× that.
const LAST_SEEN_TTL_SECONDS = 200;

// Heartbeats are liveness only — no DB write, no socket fan-out. We just refresh a hot cache
// key with the last-seen timestamp + diagnostics; a failure is logged, not retried (the next
// heartbeat re-establishes it), so we never nack a ping to the DLQ.
export function deviceHeartbeatConsumer() {
  return async (payload: DeviceHeartbeatPayload): Promise<void> => {
    const { userId, deviceId, version, timestamp, uptimeMs, freeHeap, rssi } = payload;
    const userDeviceId = parseInt(deviceId, 10);

    const value = JSON.stringify({ timestamp, version, uptimeMs, freeHeap, rssi });
    try {
      await valkey.set(keys.deviceLastSeen(userDeviceId), value, 'EX', LAST_SEEN_TTL_SECONDS);
    } catch (err) {
      log.error({ err, userDeviceId }, 'valkey device_last_seen write failed');
    }

    // Persist the latest signal diagnostics on the device row so the devices page can show RSSI
    // without a Redis dependency. Best-effort — a heartbeat is liveness, not authoritative state,
    // so a failed write is logged, never DLQ'd (the next heartbeat re-establishes it).
    try {
      await db.userDevice.update({
        where: { id: userDeviceId },
        data: {
          last_heartbeat_at: new Date(timestamp),
          ...(typeof rssi === 'number' ? { rssi } : {}),
        },
      });
    } catch (err) {
      log.error({ err, userDeviceId }, 'device heartbeat diagnostics update failed');
    }

    // A heartbeat is proof of life, so it also HEALS a wrongly-recorded offline. Liveness
    // otherwise moves only on the device's status publishes, which happen once per connect —
    // so a single mis-ordered or lost `offline` used to leave a live device shown as offline
    // indefinitely, with nothing in the system able to correct it. Bounded to the offline→
    // online direction: going offline stays the Last-Will's decision.
    try {
      const healed = await db.userDevice.updateMany({
        where: { id: userDeviceId, online: false },
        data: { online: true, last_online_date: new Date(timestamp) },
      });
      if (healed.count > 0) {
        log.warn(
          { userDeviceId },
          'device was recorded offline but is heartbeating — liveness corrected to online',
        );
        socket.emitDeviceStatusChange(parseInt(userId, 10), userDeviceId, true);
      }
    } catch (err) {
      log.error({ err, userDeviceId }, 'device liveness heal failed');
    }
    log.debug({ userId, userDeviceId, freeHeap, rssi }, 'heartbeat recorded');
  };
}
