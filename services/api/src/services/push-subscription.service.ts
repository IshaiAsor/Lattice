import { env } from '../config/env.config';
import { db } from '../db';

export interface PushSubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// api owns the write path for subscriptions (same convention as NotificationsService for
// prefs/history); notification-service only reads them when fanning out a push.
class PushSubscriptionService {
  getPublicKey(): string | null {
    return env.vapidPublicKey ?? null;
  }

  // Upsert by endpoint (not user_id+endpoint) — endpoint is globally unique per browser
  // subscription, so re-subscribing as a different user on the same browser reassigns
  // ownership rather than erroring.
  async subscribe(userId: number, input: PushSubscribeInput, userAgent?: string): Promise<void> {
    this.validate(input);
    await db.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        user_id: userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: userAgent,
      },
      update: {
        user_id: userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: userAgent,
      },
    });
  }

  // Scoped to user_id so one user can't unsubscribe another's device by guessing an
  // endpoint. deleteMany (not delete) — idempotent, no error if already gone.
  async unsubscribe(userId: number, endpoint: string): Promise<void> {
    if (!endpoint) {
      throw Object.assign(new Error('endpoint is required'), { statusCode: 400 });
    }
    await db.pushSubscription.deleteMany({ where: { user_id: userId, endpoint } });
  }

  private validate(input: PushSubscribeInput): void {
    if (!input?.endpoint || typeof input.endpoint !== 'string') {
      throw Object.assign(new Error('endpoint is required'), { statusCode: 400 });
    }
    if (!input.keys?.p256dh || !input.keys?.auth) {
      throw Object.assign(new Error('keys.p256dh and keys.auth are required'), {
        statusCode: 400,
      });
    }
  }
}

export const pushSubscriptionService = new PushSubscriptionService();
