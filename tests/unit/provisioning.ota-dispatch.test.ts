// Unit: the pure half of dispatching an OTA (device-gateway/src/services/ota-dispatch.ts) — the
// in-flight window that stops a second dispatch, the firmware URL the device fetches, and the
// topic version the update is addressed on.
//
// All three are regression tests for defects seen in production:
//   * the extensionless URL 404'd, so every user-initiated update failed with
//     `failed:-102:File Not Found (404)` and the device never left its old firmware;
//   * nothing refused a second Update press, so one device took two dispatches 23s apart —
//     each re-staging the migration and restarting a download already under way;
//   * a device addressed on the wrong version segment is published at on a topic nothing
//     subscribes to, which is how prod device 6 ended up online and uncommandable.

import {
  otaInFlight,
  firmwareDownloadUrl,
  otaTopicVersion,
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

// F3.15: an OTA is now a command aimed at one device, so it has to be addressed on a topic that
// device is actually subscribed to.
describe('otaTopicVersion', () => {
  it('uses the version the device last reported', () => {
    expect(
      otaTopicVersion({ current_firmware_version: 'v2.0.423', device: { version: 'v2.0.328' } }),
    ).toBe('v2.0.423');
  });

  // Nothing has been heard from the device since the writeback shipped — the catalog row is the
  // platform's only belief about what it runs.
  it('falls back to the catalog row when the device has never reported', () => {
    expect(
      otaTopicVersion({ current_firmware_version: null, device: { version: 'v2.0.328' } }),
    ).toBe('v2.0.328');
  });

  // The trap this function exists for. Firmware subscribes on its own compile-time
  // DEVICE_VERSION, so the topic must name what it is running now — the target names a topic
  // that will not exist until the update this command is asking for has already happened.
  it('addresses the running version, never the version being updated to', () => {
    const running = 'v2.0.423';
    const target = 'v2.0.430';
    const topic = otaTopicVersion({
      current_firmware_version: running,
      device: { version: 'v2.0.328' },
    });
    expect(topic).toBe(running);
    expect(topic).not.toBe(target);
  });
});
