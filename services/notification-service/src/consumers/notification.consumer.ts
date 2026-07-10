import type { Channel as AmqpChannel } from 'amqplib';
import {
  consume,
  QUEUES,
  type NotificationSendPayload,
  type NotificationPublishPayload,
} from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { dispatch } from '../delivery/dispatcher';
import { handlePublish } from '../delivery/fanout';

const log = createLogger('notification-service:consumer');

// Wire both notification queues. `notification.send` runs the full delivery path (F15.3);
// `notification.publish` fans a device-scoped event out to owners as per-user sends (F15.4).
export async function startConsumers(ch: AmqpChannel): Promise<void> {
  await consume<NotificationSendPayload>(ch, QUEUES.NOTIFICATION_SEND, (payload) =>
    dispatch(payload),
  );

  await consume<NotificationPublishPayload>(ch, QUEUES.NOTIFICATION_PUBLISH, (payload) =>
    handlePublish(ch, payload),
  );

  log.info('notification consumers started');
}
