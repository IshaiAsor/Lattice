// E2E: firmware updates are addressed at one device (F3.15). OTA used to reach a device only
// through the fleet-wide `ota/updates/<deviceType>` announcement, so "update this one device" was
// not expressible — pressing Update flashed every connected device of that type, and a device
// that happened to be offline missed it with no retry. An update is now the `ota` verb on the
// per-device command topic, and the broadcast is gone from both the platform and the firmware.
//
// Covers all three halves of that:
//   * the verb itself round-trips and the device adopts the version;
//   * a dispatch on `q.ota.dispatch` reaches its device and NO other device of the same type;
//   * the ack path — an `ota` ack has no UserDeviceAction behind it, and digest used to throw on
//     the ok branch trying to resolve one, dead-lettering every `starting:` progress ack.
//
// Mutating (device firmware version) — acceptance-safe as e2e-bot.

import type { Channel } from 'amqplib';
import type { MqttClient } from 'mqtt';
import {
  SimDevice,
  itStack,
  stackUp,
  backendPublisher,
  publishCommand,
  simOpts,
  poll,
  login,
  apiGet,
  settleAfterStart,
} from './helpers/stack';
import { connect, publish, QUEUES, RK } from '../../packages/queue/src';
import type { OtaDispatchPayload } from '../../packages/queue/src';

jest.setTimeout(90000);

const RABBIT_URL =
  process.env.RABBITMQ_TEST_URL ||
  `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@localhost:25672`;

// A version the sim is guaranteed to consider newer, carrying a run-unique patch so the ack it
// produces can be picked out of the DLQ by content.
function newerVersion(current: string, patch: number): string {
  const [major, minor] = String(current)
    .replace(/^[vV]/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return `v${major}.${minor}.${patch}`;
}

// Drain the DLQ looking for a message containing `marker`, requeueing everything else. Returns
// false when nothing matched within the window — which is the assertion this suite wants.
async function dlqContains(ch: Channel, marker: string, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const msg = await ch.get(QUEUES.DLQ, { noAck: false });
    if (msg === false) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (msg.content.toString().includes(marker)) {
      ch.ack(msg); // ours — consume it so a later run isn't confused by it
      return true;
    }
    ch.nack(msg, false, true);
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('per-device OTA command e2e', () => {
  let dev: any;
  // A second device of the SAME type, which must never be touched by an update aimed at `dev`.
  // That is the whole of F3.15: delivery used to be by device type, so one device's update was
  // every device's update.
  let bystander: any;
  let pub: MqttClient | null = null;
  const DEVICE_TYPE = process.env.DEVICE_TYPE || 'ESP32S3_MINI';
  const RUN = Date.now().toString(36);
  const MAC = `SIM-E2E-OTA-${RUN}`;
  const BYSTANDER_MAC = `SIM-E2E-OTA-BY-${RUN}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: DEVICE_TYPE,
        autoTelemetry: false,
        camera: false,
      }),
    );
    await dev.start();
    // Provisioning triggers a config-reload restart; let it land before commanding the device.
    await settleAfterStart(dev);
    bystander = new SimDevice(
      simOpts({
        mac: BYSTANDER_MAC,
        deviceType: DEVICE_TYPE,
        autoTelemetry: false,
        camera: false,
      }),
    );
    await bystander.start();
    pub = backendPublisher();
  });

  afterAll(async () => {
    if (pub) await new Promise((r) => pub!.end(false, {}, () => r(null)));
    if (dev) await dev.cleanup();
    if (bystander) await bystander.cleanup();
  });

  itStack(
    'an ota command on the device topic updates that device, and its ack is not DLQd',
    async () => {
      if (!pub) {
        console.warn('no app MQTT creds (MQTT_APP_*) — skipping ota command round-trip');
        return;
      }

      const from = dev.version;
      // 90000+ keeps it unambiguously newer than any real catalog version; the low digits make the
      // resulting `starting:<version>` ack unique to this run.
      const target = newerVersion(from, 90000 + (Date.now() % 1000));

      const flashed = dev.waitFor('ota', (o: any) => o.to === target, 20000);
      publishCommand(pub, dev, 'ota', {
        version: target,
        url: `http://ota-manager:3001/download/${dev.opts.deviceType}/${target}`,
      });

      const evt = await flashed;
      expect(evt.accepted).toBe(true);
      expect(evt.from).toBe(from);

      // The device adopts the version and reconnects on the new topic path — the same evidence
      // the platform settles a real OTA from.
      await poll(
        async () => dev.version,
        (v: string) => v === target,
        { timeoutMs: 20000 },
      );

      // F3.16: the platform must now LEARN that version. Nothing staged this update — there is no
      // pending_firmware_version — so `confirmOtaIfPending` does nothing, and before the writeback
      // `current_firmware_version` stayed NULL while every dispatcher fell back to the catalog row.
      // That is the "online but uncommandable" prod incident, reproduced here as its fix.
      const token = await login();
      const recorded = await poll(
        async () => {
          const devices = await apiGet('/api/devices', token);
          return devices.find((d: any) => d.id === Number(dev.deviceId));
        },
        (row: any) => row?.current_firmware_version === target,
        { timeoutMs: 20000 },
      );
      expect(recorded.current_firmware_version).toBe(target);

      // Regression guard for the ok-branch resolve: the `starting:` ack must be processed, not
      // dead-lettered. Skipped (loudly) where the broker isn't reachable from the test runner.
      let ch: Channel | null = null;
      try {
        ch = await connect(RABBIT_URL);
      } catch {
        console.warn(`RabbitMQ unreachable at ${RABBIT_URL} — skipping the DLQ assertion`);
        return;
      }
      try {
        expect(await dlqContains(ch, `starting:${target}`, 8000)).toBe(false);
      } finally {
        await new Promise<void>((resolve) => ch!.connection.close(() => resolve()));
      }
    },
  );

  itStack('an ota command for a version already running is rejected, not applied', async () => {
    if (!pub) {
      console.warn('no app MQTT creds (MQTT_APP_*) — skipping not-newer case');
      return;
    }

    const current = dev.version;
    const rejected = dev.waitFor('ota', (o: any) => o.accepted === false, 15000);
    publishCommand(pub, dev, 'ota', {
      version: current,
      url: `http://ota-manager:3001/download/${dev.opts.deviceType}/${current}`,
    });

    const evt = await rejected;
    expect(evt.reason).toBe('not-newer');
    expect(dev.version).toBe(current);
  });

  // The F3.15 acceptance criterion, tested at the layer that decides blast radius: one
  // OtaDispatchPayload on the queue, through mqtt-service, onto the wire.
  //
  // Patch band 95000+ keeps this newer than the 90000-band version the first case leaves behind,
  // whichever order Jest runs them in.
  itStack(
    'a dispatch reaches the device it names and no other device of the same type',
    async () => {
      let ch: Channel | null = null;
      try {
        ch = await connect(RABBIT_URL);
      } catch {
        console.warn(`RabbitMQ unreachable at ${RABBIT_URL} — skipping the dispatch fan-out case`);
        return;
      }

      try {
        const target = newerVersion(dev.version, 95000 + (Date.now() % 1000));
        const bystanderBefore = bystander.version;

        const flashed = dev.waitFor('ota', (o: any) => o.to === target, 25000);
        // Anything at all from the bystander is a failure — it must not so much as evaluate an
        // update it was not sent.
        const bystanderTouched = bystander
          .waitFor('ota', () => true, 12000)
          .then((o: any) => o)
          .catch(() => null);

        const payload: OtaDispatchPayload = {
          deviceType: DEVICE_TYPE,
          version: target,
          url: `http://ota-manager:3001/download/${DEVICE_TYPE}/${target}.bin`,
          timestamp: new Date().toISOString(),
          userId: Number(dev.userId),
          deviceId: Number(dev.deviceId),
          // What it is running now — the topic segment it subscribes on, not the target above.
          firmwareVersion: dev.version,
        };
        publish(ch, RK.OTA_DISPATCH, payload);

        const evt = await flashed;
        expect(evt.accepted).toBe(true);
        await poll(
          async () => dev.version,
          (v: string) => v === target,
          { timeoutMs: 20000 },
        );

        // Under the old broadcast this device took the update too, on nothing more than sharing a
        // device type with the one the user pressed Update on.
        expect(await bystanderTouched).toBeNull();
        expect(bystander.version).toBe(bystanderBefore);
      } finally {
        await new Promise<void>((resolve) => ch!.connection.close(() => resolve()));
      }
    },
  );
});
