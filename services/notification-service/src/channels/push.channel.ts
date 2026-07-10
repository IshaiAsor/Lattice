import webpush from 'web-push';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';
import type { Channel, RenderedNotification, Recipient } from './channel';

const log = createLogger('notification-service:push');

// web-push / VAPID. Disabled unless both VAPID keys are set — with no keys send() logs-and-skips.
// Subscriptions are stored per user (F15.2 adds the push-subscription endpoint); each is a
// browser PushSubscription JSON. A 404/410 from the push service means the subscription is dead
// and F15.3 will prune it.
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
        webpush
          .sendNotification(sub as webpush.PushSubscription, payload)
          .catch((err) => log.warn({ err, userId: recipient.userId }, 'push delivery failed')),
      ),
    );
    log.debug({ userId: recipient.userId, eventType: notification.eventType }, 'push sent');
  }
}
