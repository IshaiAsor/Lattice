// Integration: platform domain — @lattice/queue against a REAL RabbitMQ broker (the
// ephemeral test stack's, host port 25672). Verifies what unit tests can't: topology
// assertion, publish/consume round-trip, and the throw→nack→DLQ contract that every
// consumer in the system relies on. Uses its own test queues; never touches the q.* queues
// the services consume.
//
// Skips (does not fail) when the broker is unreachable — same philosophy as itStack.

import type { Channel, GetMessage } from 'amqplib';
import { connect, close, publish, consume, QUEUES, DLQ_ARGS } from '../../packages/queue/src';

jest.setTimeout(30000);

const RABBIT_URL =
  process.env.RABBITMQ_TEST_URL ||
  `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@localhost:25672`;

const EXCHANGE = 'iot'; // matches @lattice/queue's internal exchange name

describe('queue integration (real broker)', () => {
  let ch: Channel | null = null;
  const testQueues: string[] = [];

  beforeAll(async () => {
    try {
      ch = await connect(RABBIT_URL); // also asserts the full static topology
    } catch {
      ch = null; // broker down — every case below skips
    }
  });

  afterAll(async () => {
    if (!ch) return;
    for (const q of testQueues) {
      await ch.deleteQueue(q).catch(() => {});
    }
    await close(ch);
  });

  function itBroker(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      if (!ch) {
        console.warn(`SKIP (rabbitmq down at ${RABBIT_URL}): ${name}`);
        return;
      }
      await fn();
    });
  }

  itBroker('connect() asserted the static topology (DLQ queue exists)', async () => {
    const dlq = await ch!.checkQueue(QUEUES.DLQ);
    expect(dlq.queue).toBe(QUEUES.DLQ);
  });

  itBroker('publish → consume round-trip preserves the payload', async () => {
    const queue = `q.test.roundtrip.${Date.now()}`;
    const rk = 'test.roundtrip';
    testQueues.push(queue);
    await ch!.assertQueue(queue, { durable: false });
    await ch!.bindQueue(queue, EXCHANGE, rk);

    const received: unknown[] = [];
    await consume(ch!, queue, async (payload) => {
      received.push(payload);
    });

    const sent = { marker: `rt-${Date.now()}`, nested: { value: 42 } };
    publish(ch!, rk, sent);

    const deadline = Date.now() + 10000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(received).toEqual([sent]);
  });

  itBroker(
    'a consumer that throws sends the message to the DLQ, not back to the queue',
    async () => {
      const queue = `q.test.poison.${Date.now()}`;
      const rk = 'test.poison';
      const marker = `poison-${Date.now()}`;
      testQueues.push(queue);
      // DLQ_ARGS wires x-dead-letter-exchange exactly like the real service queues.
      await ch!.assertQueue(queue, { durable: false, arguments: DLQ_ARGS });
      await ch!.bindQueue(queue, EXCHANGE, rk);

      let attempts = 0;
      await consume(ch!, queue, async () => {
        attempts++;
        throw new Error('unprocessable — must go to DLQ');
      });

      publish(ch!, rk, { marker });

      // The message must land in q.dlq with its content intact. Bounded get-loop over a queue
      // that also carries real DLQ traffic from the stack, so anything that isn't ours is put
      // back — but only once the search is over. Requeueing a foreign message immediately
      // returns it to the head of the queue, and the loop then re-reads that same message until
      // the deadline, never reaching ours. Holding them unacked instead is what makes the loop
      // advance; nacking at the end leaves the queue as it was found.
      const foreign: GetMessage[] = [];
      let found = false;
      const deadline = Date.now() + 10000;
      while (!found && Date.now() < deadline) {
        const msg = await ch!.get(QUEUES.DLQ, { noAck: false });
        if (msg === false) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        if (msg.content.toString().includes(marker)) {
          ch!.ack(msg);
          found = true;
        } else {
          foreign.push(msg);
        }
      }
      for (const msg of foreign) ch!.nack(msg, false, true);
      expect(found).toBe(true);
      expect(attempts).toBe(1); // nack(requeue=false): no redelivery loop
    },
  );
});
