// Unit: the pure half of recording the firmware version a device reports (F3.16) —
// digest-service/src/device-version.ts.
//
// Regression context: `current_firmware_version` had exactly one writer, `confirmOtaIfPending`,
// which only fires when a *pending* OTA matches. Any other route to new firmware left the column
// NULL, every dispatcher fell back to the catalog row, and the device ended up subscribed to
// `.../v<actual>/command/#` while the platform published to `.../v<catalog>/command/...` — online
// and uncommandable. This predicate is what decides that we learned something worth writing.

import { shouldRecordVersion } from '../../services/digest-service/src/device-version';

describe('shouldRecordVersion', () => {
  it('records the first version ever observed for a device', () => {
    expect(shouldRecordVersion(null, 'v2.0.420')).toBe(true);
    expect(shouldRecordVersion(undefined, 'v2.0.420')).toBe(true);
  });

  it('does not write when the device reports what we already have', () => {
    // The steady state: one heartbeat per device per 60s must not cost a write.
    expect(shouldRecordVersion('v2.0.420', 'v2.0.420')).toBe(false);
  });

  it('records a newer version, which is the OTA-landed case', () => {
    expect(shouldRecordVersion('v2.0.412', 'v2.0.420')).toBe(true);
  });

  // The device's own report wins even when it goes backwards. A downgrade or a USB re-flash is a
  // real thing that happens to hardware, and this column exists to address the device where it
  // actually listens — not to assert where we think it ought to be.
  it('records an older version too, rather than assuming versions only move forward', () => {
    expect(shouldRecordVersion('v2.0.420', 'v2.0.412')).toBe(true);
  });

  it('ignores a missing or blank report instead of erasing what we know', () => {
    expect(shouldRecordVersion('v2.0.420', null)).toBe(false);
    expect(shouldRecordVersion('v2.0.420', undefined)).toBe(false);
    expect(shouldRecordVersion('v2.0.420', '')).toBe(false);
    expect(shouldRecordVersion('v2.0.420', '   ')).toBe(false);
  });

  it('treats a padded report as the same version, not a change', () => {
    expect(shouldRecordVersion('v2.0.420', '  v2.0.420  ')).toBe(false);
  });
});
