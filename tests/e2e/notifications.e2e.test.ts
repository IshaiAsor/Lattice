import { connect, publish, RK } from '@lattice/queue';
import type { Channel } from 'amqplib';
import { API_URL, itStack, login, apiGet, apiPost, apiDelete, poll } from './helpers/stack';

// F15 notification-service e2e. Exercises the api HTTP surface (preferences + the F15.8 login
// gate) and the full delivery path (publish notification.send → notification-service → inbox).
// Skips cleanly when the stack is down (itStack).

interface Pref {
  channel: string;
  event_type: string;
  enabled: boolean;
  is_explicit: boolean;
  locked: boolean;
}

interface NotificationRow {
  id: number;
  event_type: string;
  title: string;
  body: string;
  read_at: string | null;
}

async function putPreferences(token: string, prefs: unknown): Promise<Response> {
  return fetch(`${API_URL}/api/notifications/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ preferences: prefs }),
  });
}

describe('notifications (F15)', () => {
  let ch: Channel | null = null;

  afterAll(async () => {
    if (ch) await ch.close().catch(() => undefined);
  });

  itStack('preferences round-trip: flip a configurable cell and it persists', async () => {
    const token = await login();
    const prefs: Pref[] = await apiGet('/api/notifications/preferences', token);
    expect(prefs.length).toBeGreaterThan(0);

    const cell = prefs.find((p) => !p.locked)!;
    const next = !cell.enabled;
    const res = await putPreferences(token, [
      { channel: cell.channel, event_type: cell.event_type, enabled: next },
    ]);
    expect(res.ok).toBe(true);

    const after: Pref[] = await apiGet('/api/notifications/preferences', token);
    const changed = after.find(
      (p) => p.channel === cell.channel && p.event_type === cell.event_type,
    )!;
    expect(changed.enabled).toBe(next);
    expect(changed.is_explicit).toBe(true);
  });

  itStack('register creates an unverified account and login is gated (F15.8)', async () => {
    const rand = Date.now().toString(36);
    const username = `e2e_notif_${rand}`;
    const email = `e2e_notif_${rand}@example.com`;
    const password = 'password123';

    const reg = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, termsAccepted: true }),
    });
    expect(reg.status).toBe(202);
    expect((await reg.json()).pendingVerification).toBe(true);

    const loginRes = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(loginRes.status).toBe(403);
    expect((await loginRes.json()).error).toBe('email_not_verified');

    // Cleanup: remove the throwaway user via the admin API.
    const adminToken = await login();
    const users: { id: number; username: string | null }[] = await apiGet('/api/users', adminToken);
    const created = users.find((u) => u.username === username);
    if (created) await apiDelete(`/api/users/${created.id}`, adminToken);
  });

  itStack('notification.send is delivered to the in-app inbox', async () => {
    const token = await login();
    const me: { id: number } = await apiGet('/api/users/me', token);

    ch = await connect(process.env.RABBITMQ_URL);
    const marker = `E2E-${Date.now()}`;
    publish(ch, RK.NOTIFICATION_SEND, {
      userId: String(me.id),
      eventType: 'rule_fired',
      data: { ruleName: marker },
      // Unique key so the dedupe window never suppresses this test's notification.
      dedupeKey: marker,
    });

    const row = await poll<NotificationRow | null>(
      async () => {
        const inbox: NotificationRow[] = await apiGet('/api/notifications?limit=20', token);
        return inbox.find((n) => n.body.includes(marker)) ?? null;
      },
      (r) => r !== null,
      { timeoutMs: 10000, intervalMs: 500 },
    );
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('rule_fired');
    expect(row!.read_at).toBeNull();

    await apiPost(`/api/notifications/${row!.id}/read`, token, {});
    const unread: { count: number } = await apiGet('/api/notifications/unread-count', token);
    expect(typeof unread.count).toBe('number');
  });

  itStack('push subscription: register, upsert, validate, unsubscribe', async () => {
    const token = await login();
    const endpoint = `https://e2e-fake-push.example.com/${Date.now()}`;

    const bad = await fetch(`${API_URL}/api/notifications/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint }), // missing keys
    });
    expect(bad.status).toBe(400);

    await apiPost('/api/notifications/push/subscribe', token, {
      endpoint,
      keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' },
    });

    // Re-subscribing the same endpoint upserts rather than erroring.
    await apiPost('/api/notifications/push/subscribe', token, {
      endpoint,
      keys: { p256dh: 'fake-p256dh-2', auth: 'fake-auth-2' },
    });

    await apiDelete(
      `/api/notifications/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`,
      token,
    );
    // Idempotent — unsubscribing an already-gone endpoint doesn't error.
    await apiDelete(
      `/api/notifications/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`,
      token,
    );
  });

  itStack('push public key endpoint returns a shape the browser can consume', async () => {
    const token = await login();
    const res: { publicKey: string | null } = await apiGet(
      '/api/notifications/push/public-key',
      token,
    );
    expect('publicKey' in res).toBe(true);
    expect(res.publicKey === null || typeof res.publicKey === 'string').toBe(true);
  });
});
