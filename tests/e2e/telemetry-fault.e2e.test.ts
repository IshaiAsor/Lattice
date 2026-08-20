// E2E: fault telemetry. A sensor that fails to read publishes a fault envelope
// {"error":"read_failed","action":"<name>"} on its normal telemetry topic. The backend must
// record it (history) but NOT overwrite the action's current_state — the last good value
// stays authoritative. Mutating (telemetry history) — acceptance-safe as e2e-bot.

import {
  SimDevice,
  itStack,
  stackUp,
  login,
  apiGet,
  poll,
  simOpts,
  settleAfterStart,
} from './helpers/stack';

jest.setTimeout(60000);

describe('fault telemetry e2e', () => {
  let dev: any;
  let token: string;
  const MAC = `SIM-E2E-FAULT-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    token = await login();
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false, // drive telemetry explicitly for determinism
        camera: false,
      }),
    );
    await dev.start();
    // Provisioning triggers a config-reload restart; let it land before commanding the device.
    await settleAfterStart(dev);
  });

  afterAll(async () => {
    if (dev) await dev.cleanup();
  });

  itStack(
    'a fault reading is recorded but leaves current_state on the last good value',
    async () => {
      const sensor = dev.actions.find(
        (a: any) =>
          a.mqtt_action_type === 'telemetry' &&
          !/camera|stream|picture/i.test(a.implementation_type),
      );
      if (!sensor) {
        console.warn('no telemetry action in catalog — skipping');
        return;
      }
      const name = sensor.mqtt_action_name;
      const stateOf = (list: any[]) =>
        list.find((a) => a.deviceId === dev.deviceId && a.mqttName === name)?.state;

      // 1. A good reading establishes the authoritative current_state.
      dev.publishTelemetry(name, 42);
      await poll(
        () => apiGet('/api/actions', token),
        (list: any[]) => stateOf(list) === '42',
      );

      // 2. A fault reading (same envelope firmware emits) must NOT become current_state.
      dev.publishTelemetry(name, JSON.stringify({ error: 'read_failed', action: name }));

      // Give the consumer time to process, then assert the good value survived.
      await new Promise((r) => setTimeout(r, 4000));
      const actions = await apiGet('/api/actions', token);
      expect(stateOf(actions)).toBe('42');
    },
  );
});
