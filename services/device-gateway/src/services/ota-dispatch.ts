import { OTA_IN_FLIGHT_MS } from '@lattice/queue';

// The pure half of dispatching an OTA — no db, no queue, no env — so both rules below are
// unit-testable (tests/unit/provisioning.ota-dispatch.test.ts). Both exist because they were
// wrong in production: the URL 404'd every user-initiated update, and nothing stopped a second
// dispatch landing on a device already mid-download.

/** The pending-OTA columns this module reasons about. */
export interface PendingOta {
  pending_firmware_version: string | null;
  pending_since: Date | null;
}

/**
 * Is a dispatched OTA still running?
 *
 * A pending update that outlives the window is not in flight, it is lost — the device took the
 * announcement and never came back on the new version, so nothing will ever settle it. Treating
 * that as still running would leave the device permanently un-updatable, which is worse than
 * the duplicate dispatch this check exists to prevent. A NULL `pending_since` (a row staged
 * before the column existed) reads the same way: expired.
 */
export function otaInFlight(device: PendingOta, now: number = Date.now()): boolean {
  if (device.pending_firmware_version == null) return false;
  if (device.pending_since == null) return false;
  return now - device.pending_since.getTime() < OTA_IN_FLIGHT_MS;
}

/**
 * Where the device fetches the firmware.
 *
 * `.bin` is not decoration: ota-manager serves this path with `express.static` over a directory
 * the CI entrypoint fills as `<version>.bin`, so the extensionless URL is a 404 and the device
 * answers `failed:-102:File Not Found (404)`. It went unnoticed while release announcements
 * still dispatched the url straight out of `latest.json` (which carries the extension); once
 * that stopped, this became the only OTA path there is and no update could land.
 *
 * ESP32Code/entrypoint.sh owns the filename — keep the two in step.
 */
export function firmwareDownloadUrl(
  otaManagerUrl: string,
  deviceType: string,
  version: string,
): string {
  return `${otaManagerUrl.replace(/\/+$/, '')}/download/${deviceType}/${version}.bin`;
}
