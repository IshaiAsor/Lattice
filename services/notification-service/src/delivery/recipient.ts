import { db } from '../db/client';
import type { Recipient } from '../channels/channel';

// Resolve a user's channel-specific delivery details: email from the users table, push
// subscriptions from push_subscriptions (one row per registered browser/device).
//
// Returns null when the user doesn't exist — the caller drops the notification rather than
// half-delivering it (socket emit) and then failing the notification_history FK insert.
export async function resolveRecipient(userId: number): Promise<Recipient | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      push_subscriptions: { select: { endpoint: true, p256dh: true, auth: true } },
    },
  });
  if (!user) return null;
  return {
    userId,
    email: user.email,
    pushSubscriptions: user.push_subscriptions.map((s) => ({
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    })),
  };
}
