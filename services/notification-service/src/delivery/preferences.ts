import {
  NOTIFICATION_CHANNELS,
  defaultPrefEnabled,
  isTransactionalEvent,
  type NotificationChannel,
} from '@lattice/queue';
import { db } from '../db/client';

// Resolve which channels a notification should go to: explicit preference rows overlaid on the
// default matrix, optionally narrowed by a producer-supplied `restrict` list.
//
// Transactional events (email_verification/password_reset) bypass preferences entirely — they
// are always delivered on their default channels so a user can never miss a verify/reset email.
export async function resolveEnabledChannels(
  userId: number,
  eventType: string,
  restrict?: string[],
): Promise<NotificationChannel[]> {
  const restrictSet = restrict && restrict.length ? new Set(restrict) : null;

  if (isTransactionalEvent(eventType)) {
    return NOTIFICATION_CHANNELS.filter(
      (ch) => defaultPrefEnabled(ch, eventType) && (!restrictSet || restrictSet.has(ch)),
    );
  }

  const rows = await db.notificationPreference.findMany({
    where: { user_id: userId, event_type: eventType },
    select: { channel: true, enabled: true },
  });
  const explicit = new Map(rows.map((r) => [r.channel, r.enabled]));

  return NOTIFICATION_CHANNELS.filter((ch) => {
    if (restrictSet && !restrictSet.has(ch)) return false;
    return explicit.has(ch) ? explicit.get(ch)! : defaultPrefEnabled(ch, eventType);
  });
}
