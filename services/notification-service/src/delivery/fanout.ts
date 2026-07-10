import type { Channel as AmqpChannel } from 'amqplib';
import {
  publish,
  RK,
  type NotificationPublishPayload,
  type NotificationSendPayload,
} from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';

const log = createLogger('notification-service:fanout');

// Device-scoped events (only `ota_available` today) carry a deviceType, not a user. Resolve every
// user who owns a device of that type and re-publish a per-user `notification.send`, so the rest
// of the pipeline (prefs, dedupe, delivery) is identical to directly-targeted notifications.
export async function handlePublish(
  ch: AmqpChannel,
  payload: NotificationPublishPayload,
): Promise<void> {
  if (payload.type !== 'ota_available') {
    log.warn({ type: payload.type }, 'unknown notification.publish type — ignoring');
    return;
  }
  const { deviceType, version } = payload;

  // users owning a device whose model type matches (a user may own several — distinct them).
  const owners = await db.userDevice.findMany({
    where: { device: { type: deviceType } },
    select: { user_id: true },
    distinct: ['user_id'],
  });

  // Same (deviceType, version) shouldn't notify a user twice even if it's re-published.
  const dedupeKey = `ota:${deviceType}:${version}`;
  for (const { user_id } of owners) {
    publish(ch, RK.NOTIFICATION_SEND, {
      userId: String(user_id),
      eventType: 'ota_available',
      data: { deviceType, version },
      dedupeKey,
    } satisfies NotificationSendPayload);
  }

  log.info({ deviceType, version, recipients: owners.length }, 'OTA notification fanned out');
}
