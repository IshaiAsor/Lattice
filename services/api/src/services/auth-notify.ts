import { publish, RK, type NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { getChannel } from '../queue';
import { env } from '../config/env.config';

const log = createLogger('api:auth-notify');

// The backoffice uses hash routing, so deep links must include the '#'.
function frontendLink(pathWithQuery: string): string {
  return `${env.appBaseUrl}/#${pathWithQuery}`;
}

async function send(payload: NotificationSendPayload): Promise<void> {
  // Best-effort: a transient RabbitMQ hiccup shouldn't fail the register/forgot request. The
  // user can re-request. notification-service renders + delivers the actual email.
  try {
    const ch = await getChannel();
    publish(ch, RK.NOTIFICATION_SEND, payload);
  } catch (err) {
    log.warn({ err, eventType: payload.eventType }, 'failed to publish auth email — skipped');
  }
}

export function sendVerificationEmail(
  userId: number,
  username: string,
  token: string,
): Promise<void> {
  return send({
    userId: String(userId),
    eventType: 'email_verification',
    data: { username, verifyUrl: frontendLink(`/verify-email?token=${token}`) },
  });
}

export function sendPasswordResetEmail(
  userId: number,
  username: string,
  token: string,
): Promise<void> {
  return send({
    userId: String(userId),
    eventType: 'password_reset',
    data: { username, resetUrl: frontendLink(`/reset-password?token=${token}`) },
  });
}
