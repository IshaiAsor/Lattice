import { createLogger } from '@lattice/logger';
import type { Prisma } from '@lattice/prisma-client';
import { db } from './db/client';

const log = createLogger('digest-service:device-events');

// The durable record of what happened *to* a device, as opposed to what a device was told to do
// (F18.1). `device_commands` is the write side; this is the device's own side.
//
// Before this, an online/offline transition overwrote `user_devices.online` and left no trace.
// "How often does this thing actually drop" was unanswerable, and the only durable evidence a
// device had ever been offline was a notification row — which is deduped, so a flapping link left
// exactly one.
//
// Every availability transition funnels through `RK.DEVICE_STATE_CHANGED`: the broker's Last-Will
// publishes it, and so does automation-worker's liveness reaper for the case the broker never
// witnesses (a device losing power). So there is exactly one hook, the same property that made
// command history clean.
//
// Best-effort throughout, same contract as command-history: history is an observer. A failure to
// record must never nack a status message or undo the liveness write that matters.

/** What kind of thing happened. Kept narrow — a free-text kind is a kind nobody can query. */
export type DeviceEventKind = 'online' | 'offline' | 'firmware' | 'fault' | 'config';

async function write(
  userId: number,
  userDeviceId: number,
  kind: DeviceEventKind,
  fields: { from?: string | null; to?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.deviceEvent.create({
      data: {
        user_id: userId,
        user_device_id: userDeviceId,
        kind,
        // Truncated to the column width rather than lost: an over-long value is not a state worth
        // failing the row over.
        from_value: fields.from == null ? null : String(fields.from).slice(0, 255),
        to_value: fields.to == null ? null : String(fields.to).slice(0, 255),
        detail: fields.detail === undefined ? undefined : (fields.detail as Prisma.InputJsonValue),
        recorded_at: new Date(),
      },
    });
  } catch (err) {
    log.warn({ err, userDeviceId, kind }, 'failed to record device event — skipped');
  }
}

/**
 * An availability transition — and only a transition.
 *
 * `wasOnline` is the value read BEFORE the liveness write. Passing it is the whole point: devices
 * publish status retained and heartbeat on a timer, so the same `online` arrives over and over.
 * Writing a row per message rather than per change would bury the four transitions a day that
 * matter under thousands that do not, and the availability rollup — which measures the span
 * between consecutive rows — would read every gap as zero.
 *
 * A device seen for the first time (`wasOnline === null`) is not a transition: there is no
 * previous state for it to have moved from, and recording one would invent an event.
 */
export async function recordAvailabilityChange(
  userId: number,
  userDeviceId: number,
  wasOnline: boolean | null,
  isOnline: boolean,
  reason?: string,
): Promise<void> {
  if (wasOnline === null || wasOnline === isOnline) return;
  await write(userId, userDeviceId, isOnline ? 'online' : 'offline', {
    from: String(wasOnline),
    to: String(isOnline),
    ...(reason ? { detail: { reason } } : {}),
  });
}

/**
 * A firmware version change the platform has confirmed.
 *
 * `device_commands` deliberately excludes the `ota` action because "it has its own audit trail" —
 * this is that trail, which until now did not exist as a table anywhere.
 */
export async function recordFirmwareChange(
  userId: number,
  userDeviceId: number,
  fromVersion: string | null,
  toVersion: string,
): Promise<void> {
  if (fromVersion === toVersion) return;
  await write(userId, userDeviceId, 'firmware', { from: fromVersion, to: toVersion });
}

/**
 * A fault reading, mirrored onto the device's own timeline.
 *
 * The reading itself is already stored in `sensor_history` with `is_error` — this is not a second
 * copy of the data but an entry on the timeline the device page reads, so "it went quiet at 03:12
 * and started failing reads at 11:02" is one ordered list rather than two joined queries.
 */
export async function recordFaultReading(
  userId: number,
  userDeviceId: number,
  actionName: string,
  errorCode: string | null,
): Promise<void> {
  await write(userId, userDeviceId, 'fault', {
    to: errorCode,
    detail: { action: actionName, ...(errorCode ? { code: errorCode } : {}) },
  });
}
