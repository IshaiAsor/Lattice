// E2E: the per-device `ota` command verb (F3.15 step 1). Until now OTA reached a device only
// through the fleet-wide retained `ota/updates/<deviceType>` announcement, so "update this one
// device" was not expressible. Firmware (and the sim) now accept `ota` on the per-device command
// topic as well — both paths stay live until the whole fleet knows the verb.
//
// Also guards the ack path: an `ota` ack has no UserDeviceAction behind it, and digest used to
// throw on the ok branch trying to resolve one, dead-lettering every `starting:` progress ack.
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
} from './helpers/stack';
import { connect, QUEUES } from '../../packages/queue/src';

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
  let pub: MqttClient | null = null;
  const MAC = `SIM-E2E-OTA-${Date.now().toString(36)}`;

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
});
