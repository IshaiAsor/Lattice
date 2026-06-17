import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { OtaIncomingPayload, OtaDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('digest-service:ota-incoming');

// Permissive semver: optional leading v/V (the platform tags firmware as `vX.Y.Z`),
// then MAJOR.MINOR.PATCH with optional -prerelease / +build.
const SEMVER = /^[vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export function otaIncomingConsumer(ch: Channel) {
  return async (payload: OtaIncomingPayload): Promise<void> => {
    const { deviceType, version, url, releaseNotes, timestamp } = payload;

    // 1. Validate — a bad version is not transient; throw → nack → DLQ.
    if (!SEMVER.test(version)) {
      log.error({ deviceType, version }, 'invalid OTA version → DLQ');
      throw new Error(`invalid OTA version "${version}"`);
    }

    // 2. Audit. (Future: persist to an OtaRelease table once the schema has one.)
    log.info({ deviceType, version, url, timestamp }, 'OTA release incoming');

    // 3. Forward to mqtt-service, which publishes the retained MQTT notification.
    const dispatch: OtaDispatchPayload = { deviceType, version, url, releaseNotes, timestamp };
    publish(ch, RK.OTA_DISPATCH, dispatch);
  };
}
