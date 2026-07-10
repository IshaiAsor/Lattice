import type { NotificationHistory } from '@lattice/prisma-client';
import {
  NOTIFICATION_CHANNELS,
  USER_CONFIGURABLE_EVENT_TYPES,
  defaultPrefEnabled,
  isPrefLocked,
  isNotificationChannel,
  type NotificationChannel,
} from '@lattice/queue';
import { db } from '../db';

// One cell of the preference matrix as the UI consumes it: effective enabled state, whether it
// comes from an explicit DB row (vs. a computed default), and whether it's locked (can't change).
export interface EffectivePreference {
  channel: NotificationChannel;
  event_type: string;
  enabled: boolean;
  is_explicit: boolean;
  locked: boolean;
}

export interface PreferenceInput {
  channel: string;
  event_type: string;
  enabled: boolean;
}

// api owns all user DB writes (F2). notification-service reads these rows; it never writes them.
class NotificationsService {
  // Full matrix over user-configurable events × channels, defaults overlaid with explicit rows.
  async getPreferences(userId: number): Promise<EffectivePreference[]> {
    const rows = await db.notificationPreference.findMany({ where: { user_id: userId } });
    const byKey = new Map(rows.map((r) => [`${r.channel}:${r.event_type}`, r]));
    const out: EffectivePreference[] = [];
    for (const eventType of USER_CONFIGURABLE_EVENT_TYPES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const row = byKey.get(`${channel}:${eventType}`);
        out.push({
          channel,
          event_type: eventType,
          enabled: row ? row.enabled : defaultPrefEnabled(channel, eventType),
          is_explicit: !!row,
          locked: isPrefLocked(channel, eventType),
        });
      }
    }
    return out;
  }

  async setPreferences(userId: number, items: PreferenceInput[]): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) {
      throw Object.assign(new Error('preferences must be a non-empty array'), { statusCode: 400 });
    }
    for (const it of items) this.validatePreference(it);
    await db.$transaction(
      items.map((it) =>
        db.notificationPreference.upsert({
          where: {
            user_id_channel_event_type: {
              user_id: userId,
              channel: it.channel,
              event_type: it.event_type,
            },
          },
          create: {
            user_id: userId,
            channel: it.channel,
            event_type: it.event_type,
            enabled: it.enabled,
          },
          update: { enabled: it.enabled, updated_at: new Date() },
        }),
      ),
    );
  }

  async listHistory(
    userId: number,
    limit: number,
    before?: number,
  ): Promise<NotificationHistory[]> {
    return db.notificationHistory.findMany({
      where: { user_id: userId, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async unreadCount(userId: number): Promise<number> {
    return db.notificationHistory.count({ where: { user_id: userId, read_at: null } });
  }

  async markRead(userId: number, id: number): Promise<void> {
    const row = await db.notificationHistory.findUnique({
      where: { id },
      select: { user_id: true },
    });
    if (!row) throw Object.assign(new Error('Notification not found'), { statusCode: 404 });
    if (row.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    await db.notificationHistory.update({ where: { id }, data: { read_at: new Date() } });
  }

  async markAllRead(userId: number): Promise<void> {
    await db.notificationHistory.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
  }

  private validatePreference(it: PreferenceInput): void {
    if (!isNotificationChannel(it.channel)) {
      throw Object.assign(new Error(`unknown channel "${it.channel}"`), { statusCode: 400 });
    }
    // Transactional events (verify/reset) aren't user-configurable — reject writes to them.
    if (!(USER_CONFIGURABLE_EVENT_TYPES as readonly string[]).includes(it.event_type)) {
      throw Object.assign(new Error(`event "${it.event_type}" is not configurable`), {
        statusCode: 400,
      });
    }
    if (typeof it.enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
    }
    if (isPrefLocked(it.channel, it.event_type) && !it.enabled) {
      throw Object.assign(new Error('this notification cannot be disabled'), { statusCode: 400 });
    }
  }
}

export const notificationsService = new NotificationsService();
