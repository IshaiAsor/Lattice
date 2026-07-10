import type { DeviceHeartbeatPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';

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
    if (typeof rssi === 'number') {
      try {
        await db.userDevice.update({
          where: { id: userDeviceId },
          data: { rssi, last_heartbeat_at: new Date(timestamp) },
        });
      } catch (err) {
        log.error({ err, userDeviceId }, 'device rssi update failed');
      }
    }
    log.debug({ userId, userDeviceId, freeHeap, rssi }, 'heartbeat recorded');
  };
}
