import { Emitter } from '@socket.io/redis-emitter';
import { SOCKET_EVENTS } from '@lattice/ioredis';
import { createLogger } from '@lattice/logger';
import { valkey } from '../cache/valkey';
import type { Channel, RenderedNotification, Recipient } from './channel';

const log = createLogger('notification-service:in-app');

// Publishes onto the same Valkey channel socket-server's redis-adapter listens on, so a room
// event reaches user_{userId} with no Socket.IO server here (same pattern as digest's emitter).
const emitter = new Emitter(valkey as never);

// The in-app channel is always "enabled": Valkey is a structural dependency, not optional creds.
// F15.3 also persists a notification_history row here so the event survives for the inbox.
export class InAppChannel implements Channel {
  readonly name = 'in_app' as const;
  readonly enabled = true;

  async send(notification: RenderedNotification, recipient: Recipient): Promise<void> {
    // In-app stays untagged: the notification is rendered inside the very environment that sent
    // it, so the title needs no prefix — the field is passed through for clients that want it.
    emitter.to(`user_${recipient.userId}`).emit(SOCKET_EVENTS.NOTIFICATION, {
      eventType: notification.eventType,
      title: notification.title,
      body: notification.body,
      environment: notification.environment,
      data: notification.data,
    });
    log.debug({ userId: recipient.userId, eventType: notification.eventType }, 'in-app emitted');
  }
}
