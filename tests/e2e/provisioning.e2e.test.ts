// E2E: provisioning / device-lifecycle domain — provision, action creation, re-provision
// identity, and deletion, via the SimDevice fixture. Mutating: staging runs only as e2e-bot
// with the SIM-E2E- MAC prefix and full cleanup (docs/TESTING.md safety model).

import { SimDevice, itStack, stackUp, login, apiGet, poll, simOpts } from './helpers/stack';

jest.setTimeout(60000);

describe('provisioning e2e', () => {
  let dev: any;
  let token: string;
  const MAC = `SIM-E2E-PROV-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    token = await login();
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false,
        camera: false,
      }),
    );
    await dev.start();
  });

  afterAll(async () => {
    if (dev) await dev.cleanup();
  });

  itStack('provision creates the device and it reports online', async () => {
    const devices = await poll(
      () => apiGet('/api/devices', token),
      (list: any[]) => list.some((d) => d.id === dev.deviceId && d.online),
    );
    expect(devices.find((d: any) => d.id === dev.deviceId).online).toBe(true);
  });

  itStack('activation created actions for the catalog capabilities', async () => {
    const actions = await apiGet('/api/actions', token);
    const mine = actions.filter((a: any) => a.deviceId === dev.deviceId);
    expect(mine.length).toBeGreaterThan(0);
    for (const a of mine) {
      expect(typeof a.mqttName).toBe('string');
      expect(a.mqttName.length).toBeGreaterThan(0);
    }
  });

  itStack('re-provisioning the same MAC keeps a single device identity (upsert)', async () => {
    // Encodes the provisioning contract: a device that re-provisions (soft-reset) must be
    // upserted by MAC, not duplicated. If this fails with a NEW deviceId, the upsert
    // contract is broken (or not yet implemented) — that is a real finding, not test noise.
    const before = dev.deviceId;
    await dev.reboot({ reprovision: true });
    expect(dev.deviceId).toBe(before);

    const devices = await apiGet('/api/devices', token);
    expect(devices.filter((d: any) => d.id === before).length).toBe(1);
  });

  itStack('deleting the device removes it from the list', async () => {
    // Use a second, disposable device so the shared fixture keeps working.
    const mac2 = `SIM-E2E-PROV2-${Date.now().toString(36)}`;
    const dev2 = new SimDevice(
      simOpts({
        mac: mac2,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false,
        camera: false,
        activateAll: false,
      }),
    );
    await dev2.start();
    const id = dev2.deviceId;
    await dev2.cleanup(); // stop + DELETE /api/devices/:id

    const devices = await poll(
      () => apiGet('/api/devices', token),
      (list: any[]) => !list.some((d) => d.id === id),
    );
    expect(devices.some((d: any) => d.id === id)).toBe(false);
  });
});
