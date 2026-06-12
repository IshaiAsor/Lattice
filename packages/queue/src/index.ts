import amqplib from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

// ─── Routing key constants ────────────────────────────────────────────────────
// All services import these instead of using raw strings.

export const EXCHANGE = 'iot';

export const RK = {
  // device-gateway → ingest-worker
  telemetryArrived: (userId: number) => `telemetry.arrived.${userId}`,

  // ingest-worker → automation-worker
  rulesEvaluate: (userId: number) => `rules.evaluate.${userId}`,

  // ingest-worker / automation-worker → pipeline-worker
  pipelineTrigger: (userId: number) => `pipeline.trigger.${userId}`,

  // pipeline-worker → automation-worker
  pipelineResult: (userId: number) => `pipeline.result.${userId}`,

  // ingest-worker → google-home-service
  deviceStateChanged: (userId: number) => `device.state.changed.${userId}`,

  // automation-worker / pipeline-worker → device-gateway
  actionDispatch: (userId: number) => `action.dispatch`,
} as const;

// ─── Queue name constants ─────────────────────────────────────────────────────

export const QUEUES = {
  telemetryArrived: 'q.telemetry.arrived',
  rulesEvaluate:    'q.rules.evaluate',
  pipelineTrigger:  'q.pipeline.trigger',
  pipelineResult:   'q.pipeline.result',
  deviceStateChanged: 'q.device.state.changed',
  actionDispatch:   'q.action.dispatch',
  dlq:              'q.dlq',
} as const;

// ─── Message types ────────────────────────────────────────────────────────────

export type TelemetryArrivedPayload = {
  userId: number;
  userDeviceId: number;
  userActionId: number;
  userActionDefId: number;
  capability: string;
  value: string;
  isCameraAction: boolean;
  timestamp: string;
  traceId?: string;
};

export type RulesEvaluatePayload = {
  userId: number;
  traceId?: string;
};

export type PipelineTriggerPayload = {
  userId: number;
  pipelineId: number;
  triggerUserActionId?: number;
  traceId?: string;
};

export type PipelineResultPayload = {
  userId: number;
  pipelineId: number;
  runId: number;
  status: 'completed' | 'failed';
  output?: unknown;
  traceId?: string;
};

export type DeviceStateChangedPayload = {
  userId: number;
  userDeviceId: number;
  userActionId: number;
  value: string;
  traceId?: string;
};

export type ActionDispatchPayload = {
  userId: number;
  userDeviceId: number;
  mqttType: string;
  mqttName: string;
  value: string;
  traceId?: string;
};

// ─── Connection & channel management ─────────────────────────────────────────

let _connection: ChannelModel | undefined;
let _channel: Channel | undefined;

export async function connectQueue(): Promise<Channel> {
  if (_channel) return _channel;

  const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
  _connection = await amqplib.connect(url) as unknown as ChannelModel;
  const ch: Channel = await (_connection as any).createChannel();
  _channel = ch;

  // Topic exchange — all routing keys flow through here
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });

  // Assert all queues with DLQ binding
  await ch.assertQueue(QUEUES.dlq, { durable: true });

  const dlqArgs = {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': QUEUES.dlq,
      'x-message-ttl': 30_000,
    },
  };

  for (const [, qName] of Object.entries(QUEUES).filter(([k]) => k !== 'dlq')) {
    await ch.assertQueue(qName as string, dlqArgs);
  }

  // Bind queues to exchange routing patterns
  await ch.bindQueue(QUEUES.telemetryArrived,   EXCHANGE, 'telemetry.arrived.*');
  await ch.bindQueue(QUEUES.rulesEvaluate,      EXCHANGE, 'rules.evaluate.*');
  await ch.bindQueue(QUEUES.pipelineTrigger,    EXCHANGE, 'pipeline.trigger.*');
  await ch.bindQueue(QUEUES.pipelineResult,     EXCHANGE, 'pipeline.result.*');
  await ch.bindQueue(QUEUES.deviceStateChanged, EXCHANGE, 'device.state.changed.*');
  await ch.bindQueue(QUEUES.actionDispatch,     EXCHANGE, 'action.dispatch.*');

  (_connection as any).on('error', () => { _connection = undefined; _channel = undefined; });
  (_connection as any).on('close', () => { _connection = undefined; _channel = undefined; });

  return _channel;
}

// ─── Publish ─────────────────────────────────────────────────────────────────

export async function publish<T>(
  routingKey: string,
  payload: T,
  headers: Record<string, string> = {},
): Promise<void> {
  const ch = await connectQueue();
  const content = Buffer.from(JSON.stringify(payload));
  ch.publish(EXCHANGE, routingKey, content, {
    persistent: true,
    contentType: 'application/json',
    headers,
  });
}

// ─── Consume ─────────────────────────────────────────────────────────────────

export type MessageHandler<T> = (
  payload: T,
  headers: Record<string, string>,
  ack: () => void,
  nack: (requeue?: boolean) => void,
) => Promise<void>;

export async function consume<T>(
  queueName: string,
  handler: MessageHandler<T>,
  prefetch = 1,
): Promise<void> {
  const ch = await connectQueue();
  await ch.prefetch(prefetch);

  ch.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const headers = (msg.properties.headers ?? {}) as Record<string, string>;
    let payload: T;

    try {
      payload = JSON.parse(msg.content.toString()) as T;
    } catch {
      ch.nack(msg, false, false); // malformed → DLQ
      return;
    }

    const ack  = () => ch.ack(msg);
    const nack = (requeue = false) => ch.nack(msg, false, requeue);

    await handler(payload, headers, ack, nack);
  });
}

export { Channel, ChannelModel };
