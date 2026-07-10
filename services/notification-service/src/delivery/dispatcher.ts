import type { NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db, Prisma } from '../db/client';
import { channelByName } from '../channels/registry';
import { resolveEnabledChannels } from './preferences';
import { resolveRecipient } from './recipient';
import { render } from './templates';
import { isDuplicate } from './dedupe';

const log = createLogger('notification-service:dispatch');

// The delivery brain (F15.3): dedupe → resolve enabled channels → render → fan out → persist.
export async function dispatch(payload: NotificationSendPayload): Promise<void> {
  const userId = Number(payload.userId);
  if (!userId || isNaN(userId)) {
    log.warn({ userId: payload.userId }, 'invalid userId — dropping');
    return;
  }
  const { eventType, data, dedupeKey } = payload;

  // Resolve the recipient first: an unknown user is a permanent condition (a retry/DLQ round
  // trip won't help), so drop it here rather than emitting to a socket room and then failing
  // the notification_history FK insert. Also avoids burning a dedupe key on a dead delivery.
  const recipient = await resolveRecipient(userId);
  if (!recipient) {
    log.warn({ userId, eventType }, 'unknown user — dropping notification');
    return;
  }

  if (await isDuplicate(userId, eventType, dedupeKey)) {
    log.debug({ userId, eventType }, 'duplicate suppressed');
    return;
  }

  const enabled = await resolveEnabledChannels(userId, eventType, payload.channels);
  if (enabled.length === 0) {
    log.debug({ userId, eventType }, 'no enabled channels — nothing to deliver');
    return;
  }

  const rendered = render(eventType, data);

  const delivered: string[] = [];
  for (const name of enabled) {
    const channel = channelByName.get(name);
    if (!channel) continue;
    try {
      await channel.send({ userId, eventType, ...rendered, data }, recipient);
      delivered.push(name);
    } catch (err) {
      log.warn({ err, userId, eventType, channel: name }, 'channel delivery failed');
    }
  }

  // The inbox is the in-app channel's backing store: persist history only when in-app is enabled
  // (a user who opted out of in-app for this event shouldn't see it in their inbox).
  if (enabled.includes('in_app')) {
    await db.notificationHistory.create({
      data: {
        user_id: userId,
        event_type: eventType,
        title: rendered.title,
        body: rendered.body,
        data: data as Prisma.InputJsonValue,
        channels: delivered,
      },
    });
  }

  log.info({ userId, eventType, delivered }, 'notification dispatched');
}
