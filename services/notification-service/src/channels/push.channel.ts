import webpush from 'web-push';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';
import { db } from '../db/client';
import type { Channel, RenderedNotification, Recipient } from './channel';

const log = createLogger('notification-service:push');

// web-push / VAPID. Disabled unless both VAPID keys are set — with no keys send() logs-and-skips.
// Subscriptions are stored per user via api's /api/notifications/push/subscribe endpoint. A
// 404/410 from the push service means the subscription is dead — pruned inline below.
export class PushChannel implements Channel {
  readonly name = 'push' as const;
  readonly enabled: boolean;

  constructor() {
    const { vapidPublicKey, vapidPrivateKey, vapidSubject } = env.push;
    if (vapidPublicKey && vapidPrivateKey) {
      webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
      this.enabled = true;
    } else {
      this.enabled = false;
    }
  }

  async send(notification: RenderedNotification, recipient: Recipient): Promise<void> {
    if (!this.enabled || !recipient.pushSubscriptions?.length) {
      log.debug(
        { userId: recipient.userId, enabled: this.enabled },
        'push skipped (adapter disabled or no subscription)',
      );
      return;
    }
    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      data: notification.data,
    });
    await Promise.all(
      recipient.pushSubscriptions.map((sub) =>
        webpush.sendNotification(sub, payload).catch(async (err) => {
          if (
            err instanceof webpush.WebPushError &&
            (err.statusCode === 404 || err.statusCode === 410)
          ) {
            // Dead subscription (browser unsubscribed, uninstalled, etc). The extra catch guards
            // a race where two sends to the same dead endpoint both try to delete it — the
            // second delete hits "record not found", which is fine to swallow.
            await db.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {});
            log.info(
              { userId: recipient.userId, endpoint: sub.endpoint },
              'pruned dead push subscription',
            );
            return;
          }
          log.warn({ err, userId: recipient.userId }, 'push delivery failed');
        }),
      ),
    );
    log.debug({ userId: recipient.userId, eventType: notification.eventType }, 'push sent');
  }
}
