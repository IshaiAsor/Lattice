// Disruptive: platform domain — resilience of the running stack's consumers. These cases
// restart infrastructure and inject poison messages, so they run ONLY locally against the
// ephemeral test stack, opted in via TEST_DISRUPTIVE=1 (enforced by itDisruptive):
//
//   TEST_DISRUPTIVE=1 npx jest tests/e2e/platform.resilience.local.test.ts
//
// Case 2 is a regression guard for the production incident where RabbitMQ consumers died
// silently and devices appeared offline for hours.

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { Channel } from 'amqplib';
import { itDisruptive, poll } from './helpers/stack';
import { connect, RK, QUEUES } from '../../packages/queue/src';

jest.setTimeout(180000);

const REPO_ROOT = path.join(__dirname, '..', '..');
const RABBIT_URL =
  process.env.RABBITMQ_TEST_URL ||
  `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@localhost:25672`;
const MGMT_URL = process.env.RABBITMQ_MGMT_URL || 'http://localhost:35672';

function mgmtAuth(): string {
  const user = process.env.RABBITMQ_MGMT_USER || process.env.RABBITMQ_USER || 'guest';
  const pass = process.env.RABBITMQ_MGMT_PASS || process.env.RABBITMQ_PASSWORD || 'guest';
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

async function queueInfo(name: string): Promise<{ consumers: number } | null> {
  try {
    const r = await fetch(`${MGMT_URL}/api/queues/%2F/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Basic ${mgmtAuth()}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as { consumers: number };
  } catch {
    // The broker (and its mgmt API) may be mid-restart — that's exactly the window this
    // suite induces. Treat an unreachable API as "not ready yet" so poll() keeps retrying
    // instead of throwing out of the loop.
    return null;
  }
}

describe('platform resilience (disruptive, local only)', () => {
  itDisruptive('a malformed message is dead-lettered, and the consumer survives', async () => {
    const ch: Channel = await connect(RABBIT_URL);
    const marker = `resilience-poison-${Date.now()}`;
    try {
      // Raw publish of invalid JSON — @lattice/queue's consume wrapper JSON.parses, throws,
      // and must nack to the DLQ without killing digest's consumer.
      ch.publish('iot', RK.TELEMETRY_ARRIVED, Buffer.from(`${marker}-not-json{`), {
        persistent: true,
      });

      let found = false;
      const deadline = Date.now() + 15000;
      while (!found && Date.now() < deadline) {
        const msg = await ch.get(QUEUES.DLQ, { noAck: false });
        if (msg === false) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (msg.content.toString().includes(marker)) {
          ch.ack(msg);
          found = true;
        } else {
          ch.nack(msg, false, true);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(found).toBe(true);

      // The consumer must still be attached after swallowing the poison.
      const info = await queueInfo(QUEUES.TELEMETRY_ARRIVED);
      if (info) expect(info.consumers).toBeGreaterThanOrEqual(1);
    } finally {
      // @lattice/queue.connect() hands back an amqplib Channel; its `.connection` is the
      // low-level Connection whose close() is callback-style and returns void (not a Promise),
      // so promisify it here rather than chaining .catch on undefined.
      interface WithConnection {
        connection: { close(cb: (err?: Error) => void): void };
      }
      const conn = (ch as unknown as WithConnection).connection;
      await new Promise<void>((resolve) => conn.close(() => resolve()));
    }
  });

  itDisruptive('consumers reconnect after a broker restart', async () => {
    const before = await queueInfo(QUEUES.TELEMETRY_ARRIVED);
    if (!before) {
      console.warn(`SKIP: RabbitMQ mgmt API not reachable at ${MGMT_URL}`);
      return;
    }
    expect(before.consumers).toBeGreaterThanOrEqual(1);

    execSync('docker compose -f compose.test.yaml --env-file .env.test restart rabbitmq', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

    // Every static queue must regain at least one consumer — a queue stuck at zero is the
    // silent-offline failure mode this test exists for.
    await poll(
      async () => (await queueInfo(QUEUES.TELEMETRY_ARRIVED))?.consumers ?? 0,
      (consumers) => consumers >= 1,
      { timeoutMs: 120000, intervalMs: 2000 },
    );
    const dispatch = await poll(
      async () => (await queueInfo(QUEUES.ACTION_DISPATCH))?.consumers ?? 0,
      (consumers) => consumers >= 1,
      { timeoutMs: 60000, intervalMs: 2000 },
    );
    expect(dispatch).toBeGreaterThanOrEqual(1);
  });
});
