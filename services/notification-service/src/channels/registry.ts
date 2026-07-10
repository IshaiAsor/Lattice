import { createLogger } from '@lattice/logger';
import type { Channel, ChannelName } from './channel';
import { InAppChannel } from './inapp.channel';
import { EmailChannel } from './email.channel';
import { PushChannel } from './push.channel';
import { SmsChannel } from './sms.channel';

const log = createLogger('notification-service:channels');

// All channel adapters, constructed once. Each self-reports `enabled` based on whether its
// provider creds are present; disabled adapters stay in the list as no-op/log fallbacks so the
// fan-out logic (F15.3) never special-cases a missing channel.
export const channels: Channel[] = [
  new InAppChannel(),
  new EmailChannel(),
  new PushChannel(),
  new SmsChannel(),
];

export const channelByName = new Map<ChannelName, Channel>(channels.map((c) => [c.name, c]));

export function logChannelStatus(): void {
  for (const c of channels) {
    log.info({ channel: c.name, enabled: c.enabled }, `channel ${c.enabled ? 'ready' : 'no-op'}`);
  }
}
