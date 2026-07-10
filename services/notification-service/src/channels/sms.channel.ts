import { createLogger } from '@lattice/logger';
import type { Channel, RenderedNotification, Recipient } from './channel';

const log = createLogger('notification-service:sms');

// SMS is reserved but not built for v1 (no Twilio adapter yet) — always a no-op/log adapter.
// The slot exists so preferences/UI can reference the channel without a special case.
export class SmsChannel implements Channel {
  readonly name = 'sms' as const;
  readonly enabled = false;

  async send(notification: RenderedNotification, recipient: Recipient): Promise<void> {
    log.debug(
      { userId: recipient.userId, eventType: notification.eventType },
      'sms skipped (channel not implemented in v1)',
    );
  }
}
