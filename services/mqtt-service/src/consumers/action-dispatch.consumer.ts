import type { MqttClient } from 'mqtt';
import type { ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';

const log = createLogger('mqtt-service:action-dispatch');

export function actionDispatchConsumer(client: MqttClient) {
  return async (payload: ActionDispatchPayload): Promise<void> => {
    const version = payload.firmwareVersion ?? env.mqtt.defaultVersion;
    const topic = `users/${payload.userId}/devices/${payload.deviceId}/${version}/command/${payload.actionName}`;

    client.publish(topic, JSON.stringify(payload.command), { qos: 1 }, (err) => {
      if (err) {
        log.error({ err, topic }, 'failed to publish command to MQTT');
      } else {
        log.debug({ topic }, 'command dispatched');
      }
    });
  };
}
