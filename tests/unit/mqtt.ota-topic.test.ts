// Unit: the topic an OTA command is published on
// (mqtt-service/src/consumers/ota-dispatch.consumer.ts).
//
// F3.15. Firmware updates used to go out on `ota/updates/<deviceType>`, which names a device
// *type* and nothing narrower — so pressing Update on one device flashed every connected device
// of that type, and a device that happened to be offline missed the update with no retry. An
// update is now an `ota` command addressed at one device, so this builds the same per-device
// topic every other command uses.

import { otaCommandTopic } from '../../services/mqtt-service/src/consumers/ota-dispatch.consumer';
import type { OtaDispatchPayload } from '../../packages/queue/src';

const payload = (over: Partial<OtaDispatchPayload> = {}): OtaDispatchPayload => ({
  deviceType: 'MULTI_SOCKET_8_CH',
  version: 'v2.0.430',
  url: 'http://ota/download/MULTI_SOCKET_8_CH/v2.0.430.bin',
  timestamp: new Date().toISOString(),
  userId: 1,
  deviceId: 6,
  firmwareVersion: 'v2.0.423',
  ...over,
});

describe('otaCommandTopic', () => {
  it('addresses one device, on the same layout every other command uses', () => {
    expect(otaCommandTopic(payload())).toBe('users/1/devices/6/v2.0.423/command/ota');
  });

  // The whole point of F3.15: nothing in the topic names a device *type*, so an update cannot
  // reach a device it was not aimed at.
  it('carries no device type, so it cannot fan out across a fleet', () => {
    expect(otaCommandTopic(payload())).not.toContain('MULTI_SOCKET_8_CH');
    expect(otaCommandTopic(payload())).not.toContain('ota/updates');
  });

  // Firmware subscribes on its own compile-time DEVICE_VERSION, so the version segment must be
  // what the device is running — the target names a topic that does not exist until the update
  // this command is asking for has already happened. Publishing there is how prod device 6 ended
  // up online, heartbeating and completely uncommandable.
  it('uses the running version, not the version being updated to', () => {
    const topic = otaCommandTopic(payload({ firmwareVersion: 'v2.0.372', version: 'v2.0.430' }));
    expect(topic).toBe('users/1/devices/6/v2.0.372/command/ota');
    expect(topic).not.toContain('v2.0.430');
  });

  it('keeps the two devices of one user apart', () => {
    expect(otaCommandTopic(payload({ deviceId: 7 }))).toBe(
      'users/1/devices/7/v2.0.423/command/ota',
    );
  });
});
