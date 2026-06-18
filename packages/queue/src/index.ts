import amqplib, { Channel, ConsumeMessage } from 'amqplib';

export * from './types';

const EXCHANGE = 'iot';
const DLQ_EXCHANGE = 'iot.dlq';

// Static routing keys — no userId anywhere; userId lives in the payload.
export const RK = {
  TELEMETRY_ARRIVED:            'telemetry.arrived',
  RULES_EVALUATE:               'rules.evaluate',
  PIPELINE_TRIGGER:             'pipeline.trigger',
  PIPELINE_RESULT:              'pipeline.result',
  DEVICE_STATE_CHANGED:         'device.state.changed',
  // A UI client's intent to change an action's state, keyed by UserDeviceAction id.
  // digest resolves it (→ device/version/mqtt name), writes optimistic state + echoes,
  // then publishes ACTION_DISPATCH for the device.
  ACTION_REQUESTED:             'action.requested',
  ACTION_DISPATCH:              'action.dispatch',
  // A device's ack that it executed (or rejected) a command. digest writes the
  // authoritative current_state on success and resolves the in-flight pending request.
  ACTION_RESULT:                'action.result',
  PIPELINE_STAGE_SENSOR_DIGEST: 'pipeline.stage.sensor_digest',
  PIPELINE_STAGE_COMMAND_EXEC:  'pipeline.stage.command_exec',
  PIPELINE_STAGE_DONE:          'pipeline.stage.done.v1',
  OTA_INCOMING:                 'ota.incoming',
  OTA_DISPATCH:                 'ota.dispatch',
} as const;

export type RoutingKey = (typeof RK)[keyof typeof RK];

// Dynamic routing key for per-model ML stage queues.
export function mlStageRK(kind: string, name: string, version: string): string {
  return `pipeline.stage.${kind}.${name}.${version}`;
}

export const QUEUES = {
  TELEMETRY_ARRIVED:            'q.telemetry.arrived',
  RULES_EVALUATE:               'q.rules.evaluate',
  PIPELINE_TRIGGER:             'q.pipeline.trigger',
  PIPELINE_RESULT:              'q.pipeline.result',
  DEVICE_STATE_CHANGED:         'q.device.state.changed',
  ACTION_REQUESTED:             'q.action.requested',
  ACTION_DISPATCH:              'q.action.dispatch',
  ACTION_RESULT:                'q.action.result',
  ACTION_RESULT_GOOGLE_HOME:    'q.action.result.google-home',
  PIPELINE_STAGE_SENSOR_DIGEST: 'q.pipeline.stage.sensor_digest',
  PIPELINE_STAGE_COMMAND_EXEC:  'q.pipeline.stage.command_exec',
  PIPELINE_STAGE_DONE:          'q.pipeline.stage.done',
  OTA_INCOMING:                 'q.ota.incoming',
  OTA_DISPATCH:                 'q.ota.dispatch',
  DLQ:                          'q.dlq',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// Dynamic queue name for per-model ML stage queues.
export function mlStageQueue(kind: string, name: string, version: string): string {
  return `q.pipeline.stage.${kind}.${name}.${version}`;
}

// Applied to every queue assertion — messages TTL to DLQ after 5 min with no ack.
export const DLQ_ARGS = {
  'x-dead-letter-exchange': DLQ_EXCHANGE,
  'x-message-ttl': 300_000,
} as const;

// Static queue → routing key mapping (same key names, parallel arrays).
const STATIC_QUEUE_BINDINGS: Array<[string, string]> = [
  [QUEUES.TELEMETRY_ARRIVED,            RK.TELEMETRY_ARRIVED],
  [QUEUES.RULES_EVALUATE,               RK.RULES_EVALUATE],
  [QUEUES.PIPELINE_TRIGGER,             RK.PIPELINE_TRIGGER],
  [QUEUES.PIPELINE_RESULT,              RK.PIPELINE_RESULT],
  [QUEUES.DEVICE_STATE_CHANGED,         RK.DEVICE_STATE_CHANGED],
  [QUEUES.ACTION_REQUESTED,             RK.ACTION_REQUESTED],
  [QUEUES.ACTION_DISPATCH,              RK.ACTION_DISPATCH],
  [QUEUES.ACTION_RESULT,                RK.ACTION_RESULT],
  [QUEUES.ACTION_RESULT_GOOGLE_HOME,    RK.ACTION_RESULT],
  [QUEUES.PIPELINE_STAGE_SENSOR_DIGEST, RK.PIPELINE_STAGE_SENSOR_DIGEST],
  [QUEUES.PIPELINE_STAGE_COMMAND_EXEC,  RK.PIPELINE_STAGE_COMMAND_EXEC],
  [QUEUES.PIPELINE_STAGE_DONE,          RK.PIPELINE_STAGE_DONE],
  [QUEUES.OTA_INCOMING,                 RK.OTA_INCOMING],
  [QUEUES.OTA_DISPATCH,                 RK.OTA_DISPATCH],
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
  const ch = await conn.createChannel();

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
  const rk    = mlStageRK(kind, name, version);
  await ch.assertQueue(queue, { durable: true, arguments: DLQ_ARGS });
  await ch.bindQueue(queue, EXCHANGE, rk);
  ch.prefetch(prefetch);
  return queue;
}

export function publish<T>(ch: Channel, routingKey: string, payload: T): void {
  const ok = ch.publish(
    EXCHANGE,
    routingKey,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true, contentType: 'application/json' },
  );
  if (!ok) 
    {
      throw new Error(`RabbitMQ publish rejected (flow control / channel not writable) for routing key: ${routingKey}`);
    }
}

export async function consume<T>(
  ch: Channel,
  queue: string,
  handler: (payload: T, msg: ConsumeMessage) => Promise<void>,
): Promise<void> {
  await ch.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString()) as T;
      await handler(payload, msg);
      ch.ack(msg);
    } catch {
      // nack without requeue — message goes to DLQ via x-dead-letter-exchange
      ch.nack(msg, false, false);
    }
  });
}
