import type { MqttClient } from 'mqtt';
import type { OtaDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:ota-dispatch');

/**
 * Where a firmware update is published (F3.15).
 *
 * The same layout `action-dispatch.consumer.ts` builds, because this *is* a device command —
 * `ota` is a verb the firmware dispatches beside `restart` and `hard-reset`. Updates used to go
 * to `ota/updates/<deviceType>` instead, which is not addressed at anything: pressing Update on
 * one device flashed every connected device of that type, and a device that happened to be
 * offline missed it entirely with no retry.
 *
 * `firmwareVersion` is the version the device is RUNNING, not the one it is being sent to.
 * Firmware builds its subscription from its own compile-time DEVICE_VERSION, so the target
 * version names a topic that will not exist until the update this message is asking for has
 * already happened. There is deliberately no `env.mqtt.defaultVersion` fallback here the way
 * action-dispatch has one — the field is required, and defaulting to `v1` would publish where
 * nothing is listening.
 */
export function otaCommandTopic(payload: OtaDispatchPayload): string {
  return `users/${payload.userId}/devices/${payload.deviceId}/${payload.firmwareVersion}/command/ota`;
}

export function otaDispatchConsumer(client: MqttClient) {
  return async (payload: OtaDispatchPayload): Promise<void> => {
    const topic = otaCommandTopic(payload);
    log.info(
      {
        topic,
        deviceId: payload.deviceId,
        deviceType: payload.deviceType,
        version: payload.version,
        runningVersion: payload.firmwareVersion,
      },
      'OTA dispatch received',
    );
    const message = JSON.stringify({
      version: payload.version,
      deviceType: payload.deviceType,
      url: payload.url,
      releaseNotes: payload.releaseNotes,
      timestamp: payload.timestamp,
    });

    // Deliberately NOT retained. A retained update is redelivered on every reconnect, which turns
    // one release into an update attempt after each nightly router restart — a device already on
    // the version answers `rejected:not-newer` forever. Updates are user-initiated, so this
    // reaches the device if it is connected and is not replayed by the broker afterwards.
    client.publish(topic, message, { qos: 1, retain: false }, (err) => {
      if (err) {
        log.error({ err, topic, version: payload.version }, 'failed to publish OTA update');
      } else {
        log.info(
          { topic, version: payload.version, deviceId: payload.deviceId },
          'OTA update published',
        );
      }
    });
  };
}
