import type { MqttClient } from 'mqtt';
import type { OtaDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:ota-dispatch');

export function otaDispatchConsumer(client: MqttClient) {
  return async (payload: OtaDispatchPayload): Promise<void> => {
    const topic = `ota/updates/${payload.deviceType}`;
    log.info(
      { topic, deviceType: payload.deviceType, version: payload.version },
      'OTA dispatch received',
    );
    const message = JSON.stringify({
      version: payload.version,
      deviceType: payload.deviceType,
      url: payload.url,
      releaseNotes: payload.releaseNotes,
      timestamp: payload.timestamp,
    });

    // Deliberately NOT retained. A retained notification is redelivered to every device of
    // this type on every reconnect, which turns one release into an update attempt after each
    // nightly router restart — devices already on the version answer `rejected:not-newer`
    // forever. Updates are meant to be user-initiated, so this reaches the devices connected
    // when it is published and is not replayed by the broker afterwards.
    client.publish(topic, message, { qos: 1, retain: false }, (err) => {
      if (err) {
        log.error({ err, topic, version: payload.version }, 'failed to publish OTA update');
      } else {
        log.info(
          { topic, version: payload.version, deviceType: payload.deviceType },
          'OTA update published',
        );
      }
    });
  };
}
