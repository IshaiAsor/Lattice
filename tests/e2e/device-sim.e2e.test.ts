// End-to-end tests driving the real stack through the SimDevice fixture. They prove the simulator
// mimics a real ESP through the actual backend (provision → online → telemetry → command/ack), and
// serve as the template future system tests copy. SKIP cleanly when the stack is down.
//
// Run: `npm run test:e2e` (requires `docker compose up -d` + the backend services + seeded catalog).

import {
  SimDevice,
  itStack,
  stackUp,
  login,
  apiGet,
  poll,
  backendPublisher,
  publishCommand,
  simOpts,
} from './helpers/stack';
import type { MqttClient } from 'mqtt';

jest.setTimeout(60000);

describe('device-sim e2e', () => {
  let dev: any;
  let token: string;
  let pub: MqttClient | null = null;
  const MAC = `SIM-E2E-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return; // suite bodies are guarded by itStack
    token = await login();
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false, // tests drive telemetry explicitly for determinism
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

  itStack('provisions and comes online', async () => {
    const device = await poll(
      () => apiGet('/api/devices', token),
      (list: any[]) => list.some((d) => d.id === dev.deviceId && d.online),
    );
    expect(device.find((d: any) => d.id === dev.deviceId).online).toBe(true);
  });

  itStack('telemetry updates the action current state', async () => {
    const sensor = dev.actions.find(
      (a: any) =>
        a.mqtt_action_type === 'telemetry' && !/camera|stream|picture/i.test(a.implementation_type),
    );
    if (!sensor) {
      console.warn('no telemetry action in catalog — skipping');
      return;
    }

    dev.publishTelemetry(sensor.mqtt_action_name, 42);
    const actions = await poll(
      () => apiGet('/api/actions', token),
      (list: any[]) =>
        list.some(
          (a) =>
            a.deviceId === dev.deviceId &&
            a.mqttName === sensor.mqtt_action_name &&
            a.state === '42',
        ),
    );
    expect(
      actions.find(
        (a: any) => a.deviceId === dev.deviceId && a.mqttName === sensor.mqtt_action_name,
      ).state,
    ).toBe('42');
  });

  itStack('valid command → ok ack (echoes commandId) and state update', async () => {
    if (!pub) {
      console.warn('no app MQTT creds (MQTT_APP_*) — skipping command round-trip');
      return;
    }
    const outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');
    if (!outlet) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }

    const commandId = `e2e-${Date.now()}`;
    const ackP = dev.waitFor(
      'ack',
      (a: any) => a.action === outlet.mqtt_action_name && a.commandId === commandId,
      8000,
    );
    publishCommand(pub, dev, outlet.mqtt_action_name, { value: 'on', commandId });
    const ack = await ackP;
    expect(ack.status).toBe('ok');
    expect(ack.value).toBe('on');

    const actions = await poll(
      () => apiGet('/api/actions', token),
      (list: any[]) =>
        list.some(
          (a) =>
            a.deviceId === dev.deviceId &&
            a.mqttName === outlet.mqtt_action_name &&
            a.state === 'on',
        ),
    );
    expect(
      actions.find(
        (a: any) => a.deviceId === dev.deviceId && a.mqttName === outlet.mqtt_action_name,
      ).state,
    ).toBe('on');
  });

  itStack('invalid command → error ack (no state change)', async () => {
    if (!pub) {
      console.warn('no app MQTT creds — skipping');
      return;
    }
    const outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');
    if (!outlet) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }

    const commandId = `e2e-bad-${Date.now()}`;
    const ackP = dev.waitFor('ack', (a: any) => a.commandId === commandId, 8000);
    publishCommand(pub, dev, outlet.mqtt_action_name, { value: 'banana', commandId });
    const ack = await ackP;
    expect(ack.status).toBe('error');
  });

  itStack('duration command auto-offs with an unsolicited ack', async () => {
    if (!pub) {
      console.warn('no app MQTT creds — skipping');
      return;
    }
    const outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');
    if (!outlet) {
      console.warn('no outlet command in catalog — skipping');
      return;
    }

    const commandId = `e2e-dur-${Date.now()}`;
    const okP = dev.waitFor('ack', (a: any) => a.commandId === commandId, 8000);
    const offP = dev.waitFor(
      'ack',
      (a: any) => a.action === outlet.mqtt_action_name && a.unsolicited && a.value === 'off',
      8000,
    );
    publishCommand(pub, dev, outlet.mqtt_action_name, { value: 'on', duration: 1, commandId });
    expect((await okP).status).toBe('ok');
    expect((await offP).value).toBe('off');
  });
});
