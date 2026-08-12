import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { DeviceStateChangedPayload, NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { compareVersions } from '@lattice/capability-validation';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { socket } from '../socket/emitter';
import { confirmOtaIfPending } from '../ota-confirm';

const log = createLogger('digest-service:device-status');

// Heartbeat-length TTL: an online key auto-expires if the device stops reporting
// without sending a clean offline (e.g. power loss). Keep aligned with the device
// status publish interval.
const ONLINE_TTL_SECONDS = 90;

export function deviceStatusConsumer(ch: Channel) {
  return async (payload: DeviceStateChangedPayload): Promise<void> => {
    const { userId, deviceId, state, timestamp, version } = payload;
    const online = state === true;
    const userDeviceId = parseInt(deviceId, 10);

    log.info({ userId, deviceId, online }, 'device.status received');

    // 0. Reject status from a firmware version this device has already moved past.
    //
    // Devices publish status RETAINED on a topic carrying their firmware version, so every
    // OTA strands the previous version's retained `offline` on the broker forever — one prod
    // device currently has four, back to v2.0.328. All of them resolve to the same device and
    // are replayed on every re-subscribe (a service restart or broker reconnect), arriving
    // with fresh receive-timestamps that the newest-wins guard below cannot tell apart. Since
    // most of them say `offline`, replaying them is a coin-flip that marks a live device dead.
    // A version *newer* than the catalog row is not stale — that is a device reporting an OTA
    // that has landed but is not yet confirmed, which is exactly what section 2 settles.
    if (version != null) {
      const known = await db.userDevice.findUnique({
        where: { id: userDeviceId },
        select: { pending_firmware_version: true, device: { select: { version: true } } },
      });
      if (known == null) {
        log.warn({ userDeviceId, version }, 'status for unknown device — ignored');
        return;
      }
      if (compareVersions(version, known.device.version) < 0) {
        log.warn(
          { userDeviceId, version, currentVersion: known.device.version },
          'status from a superseded firmware version — ignored as stale retained',
        );
        return;
      }
    }

    // 1. Authoritative liveness write — failure nacks → DLQ.
    //
    // Guarded on the message's own timestamp. A reconnect emits the broker's Last-Will
    // `offline` and the device's `online` milliseconds apart (session takeover), and
    // consume() invokes handlers concurrently — so without this guard the older `offline`
    // can be applied last and strand a live device as offline until its next reconnect.
    // Writing only when we are not older makes the pair order-independent.
    const statusAt = new Date(timestamp);
    const applied = await db.userDevice.updateMany({
      where: {
        id: userDeviceId,
        OR: [{ last_online_date: null }, { last_online_date: { lte: statusAt } }],
      },
      data: { online, last_online_date: statusAt },
    });

    if (applied.count === 0) {
      log.warn(
        { userDeviceId, online, timestamp },
        'stale device status ignored — a newer status is already recorded',
      );
      return;
    }

    // 2. OTA confirmation: device reconnected on the expected new-version topic path.
    if (online && version) {
      await confirmOtaIfPending(userDeviceId, version);
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

    // 4. Notify the owner when a device drops offline (best-effort; F15.4). dedupeKey is
    // device-scoped so a flapping link collapses to one alert per dedupe window. Dropped
    // silently if notification-service isn't deployed.
    if (!online) {
      try {
        const dev = await db.userDevice.findUnique({
          where: { id: userDeviceId },
          select: { name: true },
        });
        publish(ch, RK.NOTIFICATION_SEND, {
          userId,
          eventType: 'device_offline',
          data: { deviceName: dev?.name ?? 'A device' },
          dedupeKey: `offline:${userDeviceId}`,
        } satisfies NotificationSendPayload);
      } catch (err) {
        log.warn({ err, userDeviceId }, 'failed to publish device-offline notification — skipped');
      }
    }

    log.info({ userDeviceId, online }, 'device status processed');
  };
}
