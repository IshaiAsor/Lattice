import { createLogger } from '@lattice/logger';
import { db } from './db/client';

const log = createLogger('digest-service:device-version');

/**
 * Record the firmware version a device says it is running (F3.16).
 *
 * Every command dispatcher builds its MQTT topic from `current_firmware_version ?? device.version`
 * — but until now `current_firmware_version` had exactly one writer, `confirmOtaIfPending`, which
 * only fires when a *pending* OTA matches what the device reports. Any other way a device changes
 * firmware — a stray retained broadcast, a USB flash, an OTA whose confirmation was lost — left
 * the column NULL and every dispatcher falling back to the catalog row. The device then subscribes
 * to `.../v<actual>/command/#` while the platform publishes to `.../v<catalog>/command/...`, so it
 * is online, correctly configured, and completely uncommandable. That is the prod incident F3.16
 * describes; this is the half that makes it self-heal.
 *
 * The device's own report is the truth here — including when it reports something *older* than we
 * have recorded. A downgrade or a re-flash is a real thing that happens to hardware, and the point
 * of this column is to address the device where it actually listens, not where we think it should.
 *
 * Deliberately does NOT touch `device_type_id`: repointing the catalog row is a migration decision
 * that belongs to `confirmOtaIfPending`, which stages and promotes the matching action set inside a
 * transaction. Writing the version alone is what fixes topic addressing, and nothing more.
 */
export function shouldRecordVersion(
  recorded: string | null | undefined,
  reported: string | null | undefined,
): boolean {
  if (reported == null) return false;
  const trimmed = reported.trim();
  if (trimmed === '') return false;
  return trimmed !== recorded;
}

/**
 * Best-effort persist. Callers are liveness/ack paths that must never dead-letter over this, so a
 * failure is logged and swallowed — the next heartbeat carries the same version 60s later.
 */
export async function recordReportedVersion(
  userDeviceId: number,
  reported: string | null | undefined,
  source: 'heartbeat' | 'ack' | 'status',
): Promise<void> {
  if (!shouldRecordVersion(undefined, reported)) return;
  const version = (reported as string).trim();

  try {
    // Single statement, no read-back: the WHERE encodes "only when it actually changed", so the
    // steady state (a heartbeat every 60s per device reporting the same version) costs one
    // no-op UPDATE rather than a write. The explicit null branch is required — in SQL
    // `col <> 'x'` is NULL, not true, for a NULL column, so a first observation would not match.
    const { count } = await db.userDevice.updateMany({
      where: {
        id: userDeviceId,
        OR: [{ current_firmware_version: null }, { current_firmware_version: { not: version } }],
      },
      data: { current_firmware_version: version },
    });

    if (count > 0) {
      log.info(
        { userDeviceId, version, source },
        'device reports a firmware version we had not recorded — updated',
      );
    }
  } catch (err) {
    log.error({ err, userDeviceId, version, source }, 'current_firmware_version write failed');
  }
}
