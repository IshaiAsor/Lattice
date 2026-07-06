// Unit: telemetry/commands domain — MQTT topic parsing (mqtt-service). The topic scheme is
// users/{userId}/devices/{deviceId}/{version}/{channel}[/{actionName...}] — see the firmware
// and tools/device-sim/lib/sim-device.js _base()/_statusTopic().

import { parseTopic } from '../../services/mqtt-service/src/mqtt/topic-parser';

describe('parseTopic', () => {
  it('parses a telemetry topic', () => {
    expect(parseTopic('users/1/devices/42/v2.0.1/telemetry/temperature')).toEqual({
      namespace: 'users',
      userId: '1',
      deviceId: '42',
      version: 'v2.0.1',
      channel: 'telemetry',
      actionName: 'temperature',
    });
  });

  it('parses an ack topic', () => {
    expect(parseTopic('users/1/devices/42/v2.0.1/ack/outlet')).toMatchObject({
      channel: 'ack',
      actionName: 'outlet',
    });
  });

  it('parses a status topic (no action name)', () => {
    const parsed = parseTopic('users/1/devices/42/v2.0.1/status');
    expect(parsed).toMatchObject({ channel: 'status' });
    expect(parsed?.actionName).toBeUndefined();
  });

  it('joins multi-segment action names', () => {
    expect(parseTopic('users/1/devices/42/v2.0.1/command/camera/take_picture')?.actionName).toBe(
      'camera/take_picture',
    );
  });

  it('rejects topics with fewer than six segments', () => {
    expect(parseTopic('users/1/devices/42/v2.0.1')).toBeNull();
    expect(parseTopic('ota/updates/ESP32S3_MINI')).toBeNull();
    expect(parseTopic('')).toBeNull();
  });

  it('rejects topics with empty required segments', () => {
    expect(parseTopic('users//devices/42/v2.0.1/status')).toBeNull();
    expect(parseTopic('/1/devices/42/v2.0.1/status')).toBeNull();
    expect(parseTopic('users/1/devices//v2.0.1/status')).toBeNull();
  });
});
