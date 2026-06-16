import type { MqttClient } from 'mqtt';
import type { OtaDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:ota-dispatch');

export function otaDispatchConsumer(client: MqttClient) {
  return async (payload: OtaDispatchPayload): Promise<void> => {
    const topic = `ota/updates/${payload.deviceType}`;
    const message = JSON.stringify({
      version:      payload.version,
      deviceType:   payload.deviceType,
      url:          payload.url,
      releaseNotes: payload.releaseNotes,
      timestamp:    payload.timestamp,
    });

    client.publish(topic, message, { qos: 1, retain: true }, (err) => {
      if (err) {
        log.error({ err, topic, version: payload.version }, 'failed to publish OTA update');
      } else {
        log.info({ topic, version: payload.version, deviceType: payload.deviceType }, 'OTA update published');
      }
    });
  };
}
