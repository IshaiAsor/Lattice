import { db } from '../db/client';
import type { Recipient } from '../channels/channel';

// Resolve a user's channel-specific delivery details. Email comes from the users table; push
// subscriptions are added in chunk 3 (the push adapter no-ops without them until then).
//
// Returns null when the user doesn't exist — the caller drops the notification rather than
// half-delivering it (socket emit) and then failing the notification_history FK insert.
export async function resolveRecipient(userId: number): Promise<Recipient | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) return null;
  return { userId, email: user.email };
}
