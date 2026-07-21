import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';
import type { Channel, RenderedNotification, Recipient } from './channel';
import { tagBody, tagTitle } from '../delivery/environment';

const log = createLogger('notification-service:email');

// SMTP via nodemailer. Disabled unless SMTP_HOST is configured — with no host we build no
// transport and send() logs-and-skips, so the service runs locally without a mail server.
export class EmailChannel implements Channel {
  readonly name = 'email' as const;
  readonly enabled: boolean;
  private readonly transport: Transporter | null;

  constructor() {
    if (env.smtp.host) {
      this.transport = nodemailer.createTransport({
        host: env.smtp.host,
        port: env.smtp.port,
        secure: env.smtp.secure,
        auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
      });
      this.enabled = true;
    } else {
      this.transport = null;
      this.enabled = false;
    }
  }

  async send(notification: RenderedNotification, recipient: Recipient): Promise<void> {
    if (!this.transport || !recipient.email) {
      log.debug(
        { userId: recipient.userId, hasTransport: !!this.transport, hasEmail: !!recipient.email },
        'email skipped (adapter disabled or no address)',
      );
      return;
    }
    await this.transport.sendMail({
      from: env.smtp.from,
      to: recipient.email,
      // Non-production mail is tagged in both subject and body — staging and prod commonly
      // deliver to the same mailbox, and an untagged subject must mean prod.
      subject: tagTitle(notification.title, notification.environment),
      // F15.3 replaces this with per-event HTML templates.
      text: tagBody(notification.body, notification.environment),
    });
    log.debug({ userId: recipient.userId, eventType: notification.eventType }, 'email sent');
  }
}
