// Notification domain catalog — shared by api (preference CRUD + validation) and
// notification-service (fan-out resolution). Kept here beside NotificationSendPayload so the
// channel set, event-type set, and default opt-in matrix have a single source of truth.

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// Event types a producer may publish. Also the `event_type` column values + template keys.
export const NOTIFICATION_EVENT_TYPES = [
  'emergency',
  'rule_fired',
  'device_offline',
  'ota_available',
  'email_verification',
  'password_reset',
  // An admin lowered a ceiling below what this user had chosen, and their window was trimmed to
  // fit (F18.16). Sent because the alternative is silence: the sweep quietly deletes history the
  // user believed they had asked to keep, and nothing in the UI would ever say why. There is no
  // grace period by design — a grace period means knowingly storing data above the platform's own
  // stated ceiling.
  'retention_trimmed',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isNotificationChannel(v: unknown): v is NotificationChannel {
  return typeof v === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(v);
}

export function isNotificationEventType(v: unknown): v is NotificationEventType {
  return typeof v === 'string' && (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(v);
}

// Transactional/system events — always delivered (email), never shown in the preference UI and
// not user-disableable. Everything else is user-configurable per channel.
export const TRANSACTIONAL_EVENT_TYPES: readonly NotificationEventType[] = [
  'email_verification',
  'password_reset',
];

export const USER_CONFIGURABLE_EVENT_TYPES: readonly NotificationEventType[] =
  NOTIFICATION_EVENT_TYPES.filter((t) => !TRANSACTIONAL_EVENT_TYPES.includes(t));

export function isTransactionalEvent(eventType: string): boolean {
  return (TRANSACTIONAL_EVENT_TYPES as readonly string[]).includes(eventType);
}

// Default per-(channel, event) opt-in used when the user has no explicit preference row.
//   in_app: always on (it's the inbox);
//   email:  only high-signal events (emergency, email_verification);
//   push:   off until the user subscribes a device (F15 decision 2026-07-08);
//   sms:    off — reserved, not implemented in v1.
export function defaultPrefEnabled(channel: NotificationChannel, eventType: string): boolean {
  switch (channel) {
    case 'in_app':
      return true;
    case 'email':
      // High-signal + transactional events default on; transactional ones are also forced
      // (isTransactionalEvent) so a user can never miss a verify/reset email.
      return eventType === 'emergency' || isTransactionalEvent(eventType);
    case 'push':
    case 'sms':
      return false;
  }
}

// In-app emergency notifications can't be silenced — a hard floor enforced on preference writes.
export function isPrefLocked(channel: NotificationChannel, eventType: string): boolean {
  return channel === 'in_app' && eventType === 'emergency';
}
