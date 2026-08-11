// E2E: on-demand camera capture. A user asking for a frame (POST /api/actions/:id/capture) must
// reach the device as a take_picture carrying the request's commandId, and the frame the device
// uploads must come back tagged with it and land in history — the path a pipeline's enrich stage
// takes too, minus the queue round-trip. Mutating (stores a frame) — acceptance-safe as e2e-bot.

import { SimDevice, itStack, stackUp, simOpts, login, apiGet, apiPost } from './helpers/stack';

jest.setTimeout(90000);

describe('camera on-demand capture e2e', () => {
  let dev: any;
  let token = '';
  const MAC = `SIM-E2E-CAM-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        // The camera capability only exists on a camera board's catalog entry.
        deviceType: 'ESP32S3_CAM',
        autoTelemetry: false,
        // No periodic streaming: every frame in this test must be one the capture asked for.
        camera: false,
      }),
    );
    await dev.start();
    token = await login();
  });

  afterAll(async () => {
    if (dev) await dev.cleanup();
  });

  itStack(
    'take_picture with commandId → on-demand frame resolves the pending capture',
    async () => {
      const actions = await apiGet('/api/actions', token);
      const cam = actions.find(
        (a: any) => a.deviceName && /camera|stream|picture/i.test(a.implementation_type),
      );
      if (!cam) {
        console.warn('no camera capability in catalog — skipping');
        return;
      }

      // Listen before requesting: the sim answers fast enough to beat a listener attached after.
      const uploaded = dev.waitFor('camera-frame', () => true, 20000);

      const accepted = await apiPost(`/api/actions/${cam.id}/capture`, token, {});
      expect(typeof accepted.commandId).toBe('string');
      expect(accepted.timeoutMs).toBeGreaterThan(0);

      // The device got the request, and answered THIS one — an untagged frame would be a periodic
      // snapshot that happened to arrive, which is exactly what the correlation id exists to rule out.
      const frame = await uploaded;
      expect(frame.commandId).toBe(accepted.commandId);
      expect(frame.bytes).toBeGreaterThan(0);

      // And it was stored, not just relayed: the card's on-load backfill can find it.
      const stored = await apiGet(`/api/actions/${cam.id}/last-frame`, token);
      expect(typeof stored.frame).toBe('string');
      expect(stored.frame.length).toBeGreaterThan(0);
    },
  );
});
