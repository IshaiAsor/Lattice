import amqplib, { Channel, ConsumeMessage } from 'amqplib';
import { createLogger } from '@lattice/logger';
import { RK, QUEUES, mlStageQueue, mlStageRK } from './keys';
import { EVENT_SCHEMAS } from './schemas';

export * from './types';
export * from './keys';
export * from './schemas';
export * from './notifications';

const log = createLogger('queue');

const EXCHANGE = 'iot';
const DLQ_EXCHANGE = 'iot.dlq';

// Applied to every queue assertion — messages TTL to DLQ after 5 min with no ack.
export const DLQ_ARGS = {
  'x-dead-letter-exchange': DLQ_EXCHANGE,
  'x-message-ttl': 300_000,
} as const;

/**
 * Liveness of this process's AMQP plumbing, for readiness probes.
 *
 * The failure this exists to catch: a consumer dies while the process stays up. Nothing in
 * Kubernetes notices — the container is Running, so with no readiness probe it is Ready, the
 * Deployment reports Available, ArgoCD reports Healthy, and Kargo reports Healthy. Work simply
 * stops. Exposing the state here is what lets a probe turn that into a real signal.
 */
type ConsumerState = { queue: string; consumerTag: string; alive: boolean };

let queueUsed = false;
let connectionUp = false;
const consumerRegistry = new Map<string, ConsumerState>();

function markConnectionDown(): void {
  connectionUp = false;
  // A dropped channel takes every consumer on it with it; amqplib will not re-deliver to them.
  for (const c of consumerRegistry.values()) c.alive = false;
}

export type QueueHealth = {
  /** False only when something is actually wrong; true for services that never use the queue. */
  ok: boolean;
  /** Whether this process ever called connect() — distinguishes "unused" from "down". */
  enabled: boolean;
  connected: boolean;
  consumers: Array<{ queue: string; alive: boolean }>;
};

export function getQueueHealth(): QueueHealth {
  const consumers = [...consumerRegistry.values()].map((c) => ({ queue: c.queue, alive: c.alive }));
  return {
    ok: !queueUsed || (connectionUp && consumers.every((c) => c.alive)),
    enabled: queueUsed,
    connected: connectionUp,
    consumers,
  };
}

// Static queue → routing key mapping (same key names, parallel arrays).
const STATIC_QUEUE_BINDINGS: Array<[string, string]> = [
  [QUEUES.TELEMETRY_ARRIVED, RK.TELEMETRY_ARRIVED],
  [QUEUES.TELEMETRY_ARRIVED_AUTOMATION, RK.TELEMETRY_ARRIVED],
  [QUEUES.RULES_EVALUATE, RK.RULES_EVALUATE],
  [QUEUES.PIPELINE_TRIGGER, RK.PIPELINE_TRIGGER],
  [QUEUES.PIPELINE_CANCEL, RK.PIPELINE_CANCEL],
  [QUEUES.PIPELINE_RESULT, RK.PIPELINE_RESULT],
  [QUEUES.DEVICE_STATE_CHANGED, RK.DEVICE_STATE_CHANGED],
  [QUEUES.DEVICE_HEARTBEAT, RK.DEVICE_HEARTBEAT],
  [QUEUES.ACTION_REQUESTED, RK.ACTION_REQUESTED],
  [QUEUES.ACTION_READ_REQUESTED, RK.ACTION_READ_REQUESTED],
  [QUEUES.ACTION_DISPATCH, RK.ACTION_DISPATCH],
  [QUEUES.ACTION_DISPATCH_HISTORY, RK.ACTION_DISPATCH],
  [QUEUES.ACTION_RESULT, RK.ACTION_RESULT],
  [QUEUES.ACTION_RESULT_GOOGLE_HOME, RK.ACTION_RESULT],
  [QUEUES.PICTURE_REQUESTED, RK.PICTURE_REQUESTED],
  [QUEUES.PICTURE_RESULT, RK.PICTURE_RESULT],
  [QUEUES.PIPELINE_STAGE_SENSOR_DIGEST, RK.PIPELINE_STAGE_SENSOR_DIGEST],
  [QUEUES.PIPELINE_STAGE_COMMAND_EXEC, RK.PIPELINE_STAGE_COMMAND_EXEC],
  [QUEUES.PIPELINE_STAGE_DONE, RK.PIPELINE_STAGE_DONE],
  [QUEUES.OTA_INCOMING, RK.OTA_INCOMING],
  [QUEUES.OTA_DISPATCH, RK.OTA_DISPATCH],
  [QUEUES.SEALED_TEMPLATE_APPLIED, RK.SEALED_TEMPLATE_APPLIED],
  [QUEUES.BLUEPRINT_PHASE_ADVANCE, RK.BLUEPRINT_PHASE_ADVANCE],
  [QUEUES.RETENTION_SWEEP, RK.RETENTION_SWEEP_REQUESTED],
];

function withHeartbeat(url: string, seconds = 60): string {
  if (/[?&]heartbeat=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `heartbeat=${seconds}`;
}

/**
 * Connect to RabbitMQ, assert the exchange topology and all static queues.
 * Call once at service startup; share the returned channel across the process.
 */
export async function connect(url?: string): Promise<Channel> {
  const conn = await amqplib.connect(
    withHeartbeat(url ?? process.env['RABBITMQ_URL'] ?? 'amqp://localhost'),
  );
  // Without these, a dropped connection/channel is an uncaught 'error' event —
  // the process crashes with a raw stack dump instead of a structured log line.
  // They also flip the health state a readiness probe reads, so a process that survives a
  // broker drop reports NotReady instead of sitting there Ready and idle.
  conn.on('error', (err) => {
    markConnectionDown();
    log.error({ err }, 'RabbitMQ connection error');
  });
  conn.on('close', () => {
    markConnectionDown();
    log.error('RabbitMQ connection closed');
  });

  const ch = await conn.createChannel();
  ch.on('error', (err) => {
    markConnectionDown();
    log.error({ err }, 'RabbitMQ channel error');
  });
  ch.on('close', () => {
    markConnectionDown();
    log.error('RabbitMQ channel closed');
  });

  queueUsed = true;
  connectionUp = true;

  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });

  await ch.assertExchange(DLQ_EXCHANGE, 'fanout', { durable: true });
  await ch.assertQueue(QUEUES.DLQ, { durable: true });
  await ch.bindQueue(QUEUES.DLQ, DLQ_EXCHANGE, '');

  for (const [queue, rk] of STATIC_QUEUE_BINDINGS) {
    await ch.assertQueue(queue, { durable: true, arguments: DLQ_ARGS });
    await ch.bindQueue(queue, EXCHANGE, rk);
  }

  return ch;
}

/**
 * Close the channel and its underlying connection.
 *
 * `connect()` returns the amqplib `Channel`, not the `ChannelModel` that owns the promise-style
 * `close()`, so callers only reach the connection via `ch.connection` — and that low-level
 * `Connection.close()` is callback-style (it returns `undefined`, not a promise). Promisify it here
 * so a caller gets a single awaitable teardown instead of reaching into amqplib internals. Closing
 * the connection also closes its channels.
 */
export async function close(ch: Channel): Promise<void> {
  const conn = (ch as unknown as { connection: { close(cb: (err?: unknown) => void): void } })
    .connection;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      conn.close(done);
    } catch {
      done();
    }
    // A stuck close must never hang the caller (e.g. a test's afterAll).
    setTimeout(done, 2000);
  });
}

/**
 * Assert a per-model ML stage queue and bind it to the exchange.
 * Call from ml-router at startup for each registered model.
 */
export async function assertMlQueue(
  ch: Channel,
  kind: string,
  name: string,
  version: string,
  prefetch = 1,
): Promise<string> {
  const queue = mlStageQueue(kind, name, version);
  const rk = mlStageRK(kind, name, version);
  await ch.assertQueue(queue, { durable: true, arguments: DLQ_ARGS });
  await ch.bindQueue(queue, EXCHANGE, rk);
  await ch.prefetch(prefetch);
  return queue;
}

/**
 * Assert + bind the notification queues and their DLQ routing. Called by notification-service
 * at startup — deliberately NOT in the global connect() topology, so no other service asserts
 * them (producers publish best-effort; messages drop until this service is deployed and binds).
 */
export async function assertNotificationQueues(ch: Channel): Promise<void> {
  for (const [queue, rk] of [
    [QUEUES.NOTIFICATION_PUBLISH, RK.NOTIFICATION_PUBLISH],
    [QUEUES.NOTIFICATION_SEND, RK.NOTIFICATION_SEND],
  ] as const) {
    await ch.assertQueue(queue, { durable: true, arguments: DLQ_ARGS });
    await ch.bindQueue(queue, EXCHANGE, rk);
  }
}

export function publish<T>(ch: Channel, routingKey: string, payload: T): void {
  // Event-contract enforcement (docs/TESTING.md): outside production, a payload that
  // doesn't match its zod schema is a bug at the publisher — fail here, not downstream.
  // Unknown routing keys (dynamic ML-stage keys) are not validated.
  if (process.env['NODE_ENV'] !== 'production') {
    const schema = EVENT_SCHEMAS[routingKey];
    if (schema) {
      const result = schema.safeParse(payload);
      if (!result.success) {
        throw new Error(`event contract violation on "${routingKey}": ${result.error.message}`);
      }
    }
  }
  const ok = ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
  });
  if (!ok) {
    throw new Error(
      `RabbitMQ publish rejected (flow control / channel not writable) for routing key: ${routingKey}`,
    );
  }
}

/**
 * Default in-flight bound per consumer. Without a prefetch, RabbitMQ pushes every ready message
 * at once and `consume()` dispatches the handlers concurrently — so a queue backlog becomes that
 * many simultaneous handlers. In prod this OOMKilled google-home 584 times in four days: each
 * handler held a DB query plus an outbound HomeGraph call, and the whole backlog ran at once.
 * Ten keeps throughput well above our message rates while capping the blast radius of a backlog.
 */
export const DEFAULT_PREFETCH = 10;

export async function consume<T>(
  ch: Channel,
  queue: string,
  handler: (payload: T, msg: ConsumeMessage) => Promise<void>,
  prefetch = DEFAULT_PREFETCH,
): Promise<void> {
  // global=false (amqplib's default) — the bound applies per consumer, not to the whole channel,
  // so services that call consume() several times on the one shared channel each get their own.
  await ch.prefetch(prefetch);

  // Registered before consume() resolves so the broker-cancel branch below can never race it.
  const state: ConsumerState = { queue, consumerTag: '', alive: true };
  consumerRegistry.set(queue, state);

  const { consumerTag } = await ch.consume(queue, async (msg) => {
    // amqplib delivers null when the *broker* cancels the consumer (queue deleted, node
    // failover, channel torn down). Returning quietly here is exactly the silent-offline bug:
    // the process keeps running, healthy in every external view, subscribed to nothing.
    if (!msg) {
      state.alive = false;
      log.error({ queue }, 'consumer cancelled by broker — no longer receiving messages');
      return;
    }
    try {
      const payload = JSON.parse(msg.content.toString()) as T;
      await handler(payload, msg);
      ch.ack(msg);
    } catch (err) {
      log.error({ err, queue }, 'consumer error — nacking to DLQ');
      // nack without requeue — message goes to DLQ via x-dead-letter-exchange
      ch.nack(msg, false, false);
    }
  });

  state.consumerTag = consumerTag;
}
