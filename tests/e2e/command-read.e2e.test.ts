// E2E: the reserved `read` verb on a command (actuator) action. Sending {"value":"read"} must
// report the action's current persisted state on the ack topic WITHOUT executing or validating
// anything — and it must still answer correctly after a device restart (state restored from the
// NVS analog). Mutating (device state) — acceptance-safe as e2e-bot.

import {
  SimDevice,
  itStack,
  stackUp,
  backendPublisher,
  publishCommand,
  simOpts,
} from './helpers/stack';
import type { MqttClient } from 'mqtt';

jest.setTimeout(60000);

describe('command read-verb e2e', () => {
  let dev: any;
  let pub: MqttClient | null = null;
  const MAC = `SIM-E2E-READ-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false,
        camera: false,
      }),
    );
    await dev.start();
    pub = backendPublisher();
  });

  afterAll(async () => {
    if (pub) await new Promise((r) => pub!.end(false, {}, () => r(null)));
    if (dev) await dev.cleanup();
  });

  itStack('read reports current state, and still does after a restart', async () => {
    if (!pub) {
      console.warn('no app MQTT creds (MQTT_APP_*) — skipping read round-trip');
      return;
    }
    const outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');
    if (!outlet) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }
    const name = outlet.mqtt_action_name;

    // 1. Establish state with a real command.
    const setId = `e2e-set-${Date.now()}`;
    const setAck = dev.waitFor('ack', (a: any) => a.commandId === setId, 8000);
    publishCommand(pub, dev, name, { value: 'on', commandId: setId });
    expect((await setAck).status).toBe('ok');

    // 2. read → ack carries the current state, no execution.
    const readId = `e2e-read-${Date.now()}`;
    const readAck = dev.waitFor(
      'ack',
      (a: any) => a.action === name && a.commandId === readId,
      8000,
    );
    publishCommand(pub, dev, name, { value: 'read', commandId: readId });
    const ack = await readAck;
    expect(ack.status).toBe('ok');
    expect(ack.value).toBe('on');

    // 3. After a restart, read still returns the persisted state.
    await dev.reboot();
    const readId2 = `e2e-read2-${Date.now()}`;
    const readAck2 = dev.waitFor(
      'ack',
      (a: any) => a.action === name && a.commandId === readId2,
      10000,
    );
    publishCommand(pub, dev, name, { value: 'read', commandId: readId2 });
    expect((await readAck2).value).toBe('on');
  });
});
