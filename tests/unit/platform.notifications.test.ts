import {
  NOTIFICATION_EVENT_TYPES,
  USER_CONFIGURABLE_EVENT_TYPES,
  defaultPrefEnabled,
  isPrefLocked,
  isTransactionalEvent,
  isNotificationChannel,
} from '@lattice/queue';
import { render } from '../../services/notification-service/src/delivery/templates';
import {
  isProductionEnvironment,
  normalizeEnvironment,
  tagBody,
  tagTitle,
} from '../../services/notification-service/src/delivery/environment';

// Firmware-of-Node: the notification catalog + templates are pure logic shared by api (prefs
// validation/defaults) and notification-service (fan-out). These lock the matrix the two sides
// must agree on, plus the per-event rendering.

describe('notification preference matrix', () => {
  it('in-app defaults on for every event (it is the inbox)', () => {
    for (const ev of NOTIFICATION_EVENT_TYPES) {
      expect(defaultPrefEnabled('in_app', ev)).toBe(true);
    }
  });

  it('email defaults on only for emergency + transactional events', () => {
    expect(defaultPrefEnabled('email', 'emergency')).toBe(true);
    expect(defaultPrefEnabled('email', 'email_verification')).toBe(true);
    expect(defaultPrefEnabled('email', 'password_reset')).toBe(true);
    expect(defaultPrefEnabled('email', 'rule_fired')).toBe(false);
    expect(defaultPrefEnabled('email', 'device_offline')).toBe(false);
    expect(defaultPrefEnabled('email', 'ota_available')).toBe(false);
  });

  it('push and sms default off everywhere', () => {
    for (const ev of NOTIFICATION_EVENT_TYPES) {
      expect(defaultPrefEnabled('push', ev)).toBe(false);
      expect(defaultPrefEnabled('sms', ev)).toBe(false);
    }
  });

  it('in-app emergency is locked; nothing else is', () => {
    expect(isPrefLocked('in_app', 'emergency')).toBe(true);
    expect(isPrefLocked('email', 'emergency')).toBe(false);
    expect(isPrefLocked('in_app', 'rule_fired')).toBe(false);
  });

  it('transactional events are excluded from the user-configurable set', () => {
    expect(isTransactionalEvent('email_verification')).toBe(true);
    expect(isTransactionalEvent('password_reset')).toBe(true);
    expect(isTransactionalEvent('rule_fired')).toBe(false);
    expect(USER_CONFIGURABLE_EVENT_TYPES).not.toContain('email_verification');
    expect(USER_CONFIGURABLE_EVENT_TYPES).not.toContain('password_reset');
    expect(USER_CONFIGURABLE_EVENT_TYPES).toContain('rule_fired');
  });

  it('validates channel names', () => {
    expect(isNotificationChannel('email')).toBe(true);
    expect(isNotificationChannel('carrier_pigeon')).toBe(false);
  });
});

describe('notification templates', () => {
  it('renders each known event with its data', () => {
    expect(render('ota_available', { deviceType: 'ESP32S3_MINI', version: 'v2.0.9' })).toEqual({
      title: 'Firmware update available',
      body: expect.stringContaining('v2.0.9'),
    });
    expect(render('device_offline', { deviceName: 'Greenhouse Fan' }).body).toContain(
      'Greenhouse Fan',
    );
    expect(render('password_reset', { username: 'bob', resetUrl: 'https://x/y' }).body).toContain(
      'https://x/y',
    );
    expect(render('rule_fired', { ruleName: 'Night mode' }).body).toContain('Night mode');
  });

  it('falls back gracefully for an unknown event type', () => {
    const r = render('some_new_event', { a: 1 });
    expect(r.title).toBe('some new event');
    expect(r.body).toContain('1');
  });

  it('tolerates missing data fields without throwing', () => {
    expect(() => render('ota_available', {})).not.toThrow();
    expect(render('device_offline', {}).body).toContain('A device');
  });
});

describe('environment tagging', () => {
  it('leaves production notifications untagged', () => {
    expect(tagTitle('Device offline', 'production')).toBe('Device offline');
    expect(tagTitle('Device offline', 'PROD')).toBe('Device offline');
    expect(tagBody('A device went offline.', 'production')).toBe('A device went offline.');
  });

  it('prefixes the title and footers the body outside production', () => {
    expect(tagTitle('Device offline', 'staging')).toBe('[STAGING] Device offline');
    expect(tagTitle('Device offline', 'development')).toBe('[DEVELOPMENT] Device offline');
    expect(tagBody('A device went offline.', 'staging')).toContain(
      'Sent from the staging environment.',
    );
  });

  // Fail loud, not silent: a missing LATTICE_ENV must never impersonate production, since an
  // untagged subject is exactly what tells a reader "this one is real".
  it('treats a missing or blank environment as unknown, not production', () => {
    expect(isProductionEnvironment(undefined)).toBe(false);
    expect(normalizeEnvironment('  ')).toBe('unknown');
    expect(tagTitle('Device offline', undefined)).toBe('[UNKNOWN] Device offline');
  });
});
