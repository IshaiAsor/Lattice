import { OTA_IN_FLIGHT_MS } from '@lattice/queue';

// The pure half of dispatching an OTA — no db, no queue, no env — so the rules below are
// unit-testable (tests/unit/provisioning.ota-dispatch.test.ts). They exist because each was
// wrong in production: the URL 404'd every user-initiated update, nothing stopped a second
// dispatch landing on a device already mid-download, and addressing a device by the wrong
// version segment published commands into the void.

/** The pending-OTA columns this module reasons about. */
export interface PendingOta {
  pending_firmware_version: string | null;
  pending_since: Date | null;
}

/**
 * The MQTT topic version segment an OTA command must be addressed on.
 *
 * The version the device is RUNNING — never the one it is being updated to. Firmware builds its
 * command subscription from its own compile-time `DEVICE_VERSION`, so the target version names a
 * topic that does not exist until the update this command is asking for has already happened.
 *
 * `current_firmware_version` is what the device last reported (digest writes it back from
 * heartbeat/ack/status since F3.16); the catalog row is the fallback for a device that has not
 * reported since. Same resolution every other dispatcher uses — see
 * `api/src/services/device-command.dispatch.ts` and `digest/consumers/action-requested.consumer.ts`.
 */
export function otaTopicVersion(device: {
  current_firmware_version: string | null;
  device: { version: string };
}): string {
  return device.current_firmware_version ?? device.device.version;
}

/**
 * Is a dispatched OTA still running?
 *
 * A pending update that outlives the window is not in flight, it is lost — the device took the
 * announcement and never came back on the new version, so nothing will ever settle it. Treating
 * that as still running would leave the device permanently un-updatable, which is worse than
 * the duplicate dispatch this check exists to prevent. A NULL `pending_since` (a row staged
 * before the column existed) reads the same way: expired.
 *
 * Still worth guarding now that a dispatch reaches only the one device it names: each apply
 * tears down the staged action set and rebuilds it, and a device mid-download restarts from the
 * top on a second `ota` command.
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
