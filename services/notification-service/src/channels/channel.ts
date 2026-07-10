// The common contract every delivery channel implements. F15.3 renders a NotificationSendPayload
// into a RenderedNotification (per-channel templating) and calls send() on each enabled channel
// the user's preferences allow.

// Channel identifiers — also the `channel` column values in notification_preferences.
export type ChannelName = 'in_app' | 'email' | 'push' | 'sms';

export interface RenderedNotification {
  userId: number;
  eventType: string;
  title: string;
  body: string;
  // Optional structured payload (deep-link target, template vars, etc.).
  data?: Record<string, unknown>;
}

// The recipient's channel-specific delivery details, resolved from the DB in F15.2/F15.3.
// All optional — an adapter skips (logs) when its required detail is absent.
export interface Recipient {
  userId: number;
  email?: string;
  // web-push subscriptions (browser PushSubscription JSON), one per registered device.
  pushSubscriptions?: unknown[];
  phone?: string;
}

export interface Channel {
  readonly name: ChannelName;
  // false ⇒ this adapter has no provider configured and runs as a no-op/log adapter.
  readonly enabled: boolean;
  send(notification: RenderedNotification, recipient: Recipient): Promise<void>;
}
