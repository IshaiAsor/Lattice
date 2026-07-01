import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { OtaIncomingPayload, OtaDispatchPayload, NotificationPublishPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('digest-service:ota-incoming');

// Permissive semver: optional leading v/V (the platform tags firmware as `vX.Y.Z`),
// then MAJOR.MINOR.PATCH with optional -prerelease / +build.
// Hyphen moved to the end of character classes to avoid being treated as a range separator.
const SEMVER = /^[vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function otaIncomingConsumer(ch: Channel) {
  return async (payload: OtaIncomingPayload): Promise<void> => {
    const { deviceType, url, releaseNotes, timestamp } = payload;
    const version = payload.version?.trim();

    // 1. Validate — a bad version is not transient; throw → nack → DLQ.
    if (!version || !SEMVER.test(version)) {
      log.error({ deviceType, version }, 'invalid OTA version → DLQ');
      throw new Error(`invalid OTA version "${version}"`);
    }

    log.info({ deviceType, version, url, timestamp }, 'OTA release incoming');

    // Forward to mqtt-service, which publishes the retained MQTT notification.
    const dispatch: OtaDispatchPayload = { deviceType, version, url, releaseNotes, timestamp };
    publish(ch, RK.OTA_DISPATCH, dispatch);

    // Notify users best-effort — notification-service (F15) binds q.notification.publish
    // and resolves which users own a device of this type. Drops silently if not yet deployed.
    try {
      publish(ch, RK.NOTIFICATION_PUBLISH, {
        type: 'ota_available',
        deviceType,
        version,
      } satisfies NotificationPublishPayload);
    } catch (err) {
      log.warn({ err, deviceType, version }, 'failed to publish OTA notification event — skipped');
    }
  };
}
