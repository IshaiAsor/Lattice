import { initOTel } from '@lattice/otel';
import { createLogger } from '@lattice/logger';
import { connect, consume, QUEUES } from '@lattice/queue';
import express from 'express';
import { env } from './config/env.config';
import { createMqttClient, mqttConnected } from './mqtt/client';
import { TopicRouter } from './mqtt/topic-router';
import { SUBSCRIBE_TOPICS } from './mqtt/subscriptions';
import { deviceStatusHandler } from './handlers/device-status.handler';
import { deviceTelemetryHandler } from './handlers/device-telemetry.handler';
import { deviceAckHandler } from './handlers/device-ack.handler';
import { actionDispatchConsumer } from './consumers/action-dispatch.consumer';
import { otaDispatchConsumer } from './consumers/ota-dispatch.consumer';
import { healthRouter } from './routes/health.routes';

const { metricsHandler } = initOTel('mqtt-service');
const log = createLogger('mqtt-service');

async function main() {
  const client = createMqttClient(env.mqtt);

  client.on('error', (err) => log.error({ err }, 'MQTT error'));
  client.on('reconnect', () => log.warn('MQTT reconnecting'));
  client.on('offline', () => log.warn('MQTT offline'));

  log.info({ host: env.mqtt.host, port: env.mqtt.port }, 'connecting to MQTT broker');
  await mqttConnected(client);
  log.info('MQTT connected');

  await new Promise<void>((resolve, reject) => {
    client.subscribe([...SUBSCRIBE_TOPICS], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  log.info({ topics: SUBSCRIBE_TOPICS }, 'subscribed to MQTT topics');

  const ch = await connect(env.rabbitmqUrl);
  ch.on('close', () => { log.error('RabbitMQ channel closed — exiting for restart'); process.exit(1); });
  (ch as any).connection?.on('close', () => { log.error('RabbitMQ connection closed — exiting for restart'); process.exit(1); });
  log.info('RabbitMQ connected');

  const handlers = [
    deviceStatusHandler(ch),
    deviceTelemetryHandler(ch),
    deviceAckHandler(ch),
  ];

  const router = new TopicRouter();
  for (const h of handlers) {
    router.register(h.pattern, h.handle);
  }

  client.on('message', (topic, payload) => {
    router.route(topic, payload).catch((err) => log.error({ err, topic }, 'unhandled route error'));
  });

  await consume(ch, QUEUES.ACTION_DISPATCH, actionDispatchConsumer(client));
  await consume(ch, QUEUES.OTA_DISPATCH, otaDispatchConsumer(client));
  log.info('consumers started (action-dispatch, ota-dispatch)');

  const app = express();
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.listen(env.port, () => log.info({ port: env.port }, 'mqtt-service listening'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
