// Unit: the pure half of dispatching an OTA (device-gateway/src/services/ota-dispatch.ts) —
// the in-flight window that stops a second dispatch, and the firmware URL the device fetches.
//
// Both are regression tests for defects seen on staging:
//   * the extensionless URL 404'd, so every user-initiated update failed with
//     `failed:-102:File Not Found (404)` and the device never left its old firmware;
//   * nothing refused a second Update press, so one device took two dispatches 23s apart —
//     each re-staging the migration and re-announcing the firmware to the whole device type.

import {
  otaInFlight,
  firmwareDownloadUrl,
} from '../../services/device-gateway/src/services/ota-dispatch';
import { OTA_IN_FLIGHT_MS } from '../../packages/queue/src';

describe('otaInFlight', () => {
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
  const agoMs = (ms: number) => new Date(NOW - ms);

  it('is false when no update is pending', () => {
    expect(otaInFlight({ pending_firmware_version: null, pending_since: null }, NOW)).toBe(false);
  });

  it('is true for an update dispatched moments ago', () => {
    expect(
      otaInFlight({ pending_firmware_version: 'v2.0.420', pending_since: agoMs(2000) }, NOW),
    ).toBe(true);
  });

  it('is true just inside the window', () => {
    expect(
      otaInFlight(
        { pending_firmware_version: 'v2.0.420', pending_since: agoMs(OTA_IN_FLIGHT_MS - 1000) },
        NOW,
      ),
    ).toBe(true);
  });

  // The escape hatch: a device that went offline mid-download never acks and never reports the
  // new version, so its pending row would otherwise lock updates for that device forever.
  it('is false once the window has passed, so the update can be retried', () => {
    expect(
      otaInFlight(
        { pending_firmware_version: 'v2.0.420', pending_since: agoMs(OTA_IN_FLIGHT_MS + 1000) },
        NOW,
      ),
    ).toBe(false);
  });

  // Rows staged before pending_since existed carry no dispatch time. Permissive is the right
  // reading: an update that old is not running.
  it('is false when the dispatch time is unknown', () => {
    expect(otaInFlight({ pending_firmware_version: 'v2.0.420', pending_since: null }, NOW)).toBe(
      false,
    );
  });
});

describe('firmwareDownloadUrl', () => {
  // ota-manager serves the firmware directory with express.static, and CI writes the files as
  // `<version>.bin` (ESP32Code/entrypoint.sh) — without the extension the device gets a 404.
  it('addresses the firmware file the CI entrypoint writes', () => {
    expect(firmwareDownloadUrl('https://ota.example.org', 'ESP32S3_CAM', 'v2.0.420')).toBe(
      'https://ota.example.org/download/ESP32S3_CAM/v2.0.420.bin',
    );
  });

  it('does not double the separator when the base url has a trailing slash', () => {
    expect(firmwareDownloadUrl('https://ota.example.org/', 'ESP32S3_MINI', 'v2.0.420')).toBe(
      'https://ota.example.org/download/ESP32S3_MINI/v2.0.420.bin',
    );
  });
});
