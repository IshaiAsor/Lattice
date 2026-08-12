import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { OtaIncomingPayload, NotificationPublishPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('digest-service:ota-incoming');

// Permissive semver: optional leading v/V (the platform tags firmware as `vX.Y.Z`),
// then MAJOR.MINOR.PATCH with optional -prerelease / +build.
// Hyphen moved to the end of character classes to avoid being treated as a range separator.
const SEMVER = /^[vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function otaIncomingConsumer(ch: Channel) {
  return async (payload: OtaIncomingPayload): Promise<void> => {
    const { deviceType, url, timestamp } = payload;
    const version = payload.version?.trim();

    // 1. Validate — a bad version is not transient; throw → nack → DLQ.
    if (!version || !SEMVER.test(version)) {
      log.error({ deviceType, version }, 'invalid OTA version → DLQ');
      throw new Error(`invalid OTA version "${version}"`);
    }

    log.info({ deviceType, version, url, timestamp }, 'OTA release incoming');

    // Deliberately does NOT dispatch to devices. ota-manager announces every firmware in its
    // store on startup, so forwarding this to OTA_DISPATCH pushed an update to every device of
    // the type on each restart of that pod — with no pending_firmware_version staged, which is
    // the state an OTA can never be confirmed from. The device then reboots onto firmware the
    // platform does not know it runs, and since command topics carry the version, it goes deaf.
    // That is exactly how prod device 6 stranded itself.
    //
    // A release is now an ANNOUNCEMENT only: users are told, and the devices page derives its
    // update badge from the catalog. Actually updating a device is user-initiated and goes
    // through device-gateway's applyUpdate, which stages the pending version (so the OTA can be
    // confirmed) and publishes OTA_DISPATCH itself.

    // Notify users best-effort — notification-service (F15) binds q.notification.publish
    // and resolves which users own a device of this type. Drops silently if not yet deployed.
    try {
      publish(ch, RK.NOTIFICATION_PUBLISH, {
        type: 'ota_available',
        deviceType,
        version,
      } satisfies NotificationPublishPayload);
      log.info({ deviceType, version }, 'OTA notification event published');
    } catch (err) {
      log.warn({ err, deviceType, version }, 'failed to publish OTA notification event — skipped');
    }
  };
}
