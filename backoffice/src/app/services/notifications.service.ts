import { inject, Injectable, Injector, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';
import { AuthService } from './auth.service';
import { DeviceSocketService } from './device.socket.service';

// One cell of the preference matrix (mirrors the api EffectivePreference shape).
export interface NotificationPreference {
  channel: 'in_app' | 'email' | 'push' | 'sms';
  event_type: string;
  enabled: boolean;
  is_explicit: boolean;
  locked: boolean;
}

export interface NotificationItem {
  id: number;
  event_type: string;
  title: string;
  body: string;
  data?: unknown;
  channels: string[];
  read_at: string | null;
  created_at: string;
}

// Root service: owns the live unread badge + inbox, backed by /api/notifications and the
// `notification` socket event (delivered by notification-service's in-app channel).
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private base = `${apiUrl()}/api/notifications`;
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  // Injector (not direct inject) so we DON'T construct DeviceSocketService until authenticated —
  // that service reads the auth token once in its constructor, so creating it on the login page
  // would leave it stuck on a null token and never reconnect after sign-in.
  private injector = inject(Injector);

  readonly unreadCount = signal(0);
  readonly items = signal<NotificationItem[]>([]);

  // Client-side id for optimistic socket-pushed rows (replaced on the next full load).
  private tempId = -1;
  private liveWired = false;

  // Subscribe to live in-app deliveries. Idempotent + no-op until a user is present; safe to
  // call from the shell (on load, if authenticated) and from the notifications page.
  connectLive(): void {
    if (this.liveWired || !this.auth.isLoggedIn()) return;
    this.liveWired = true;
    const socket = this.injector.get(DeviceSocketService);
    socket.notification$.subscribe((n) => {
      // Bump the badge + prepend a provisional row so an open inbox updates instantly. The
      // authoritative row (with a real id) arrives on the next refresh.
      this.unreadCount.update((c) => c + 1);
      this.items.update((list) => [
        {
          id: this.tempId--,
          event_type: n.eventType,
          title: n.title,
          body: n.body,
          data: n.data,
          channels: ['in_app'],
          read_at: null,
          created_at: new Date().toISOString(),
        },
        ...list,
      ]);
    });
  }

  // Called by the shell once a user is authenticated, so the badge is correct on load.
  refreshUnread(): void {
    if (!this.auth.isLoggedIn()) return;
    this.http
      .get<{ count: number }>(`${this.base}/unread-count`)
      .subscribe((r) => this.unreadCount.set(r.count));
  }

  loadInbox(limit = 30): void {
    this.http
      .get<NotificationItem[]>(`${this.base}?limit=${limit}`)
      .subscribe((rows) => this.items.set(rows));
  }

  getPreferences(): Observable<NotificationPreference[]> {
    return this.http.get<NotificationPreference[]>(`${this.base}/preferences`);
  }

  setPreferences(
    preferences: Pick<NotificationPreference, 'channel' | 'event_type' | 'enabled'>[],
  ): Observable<NotificationPreference[]> {
    return this.http.put<NotificationPreference[]>(`${this.base}/preferences`, { preferences });
  }

  markRead(id: number): void {
    // Optimistic: only real (server) rows have a positive id + an endpoint.
    this.applyRead((it) => it.id === id);
    if (id > 0) this.http.post(`${this.base}/${id}/read`, {}).subscribe();
  }

  markAllRead(): void {
    this.applyRead(() => true);
    this.http.post(`${this.base}/read-all`, {}).subscribe();
  }

  deleteOne(item: NotificationItem): void {
    this.items.update((list) => list.filter((it) => it.id !== item.id));
    if (item.read_at === null) this.unreadCount.update((c) => Math.max(0, c - 1));
    // Only real (server) rows have a positive id + an endpoint; drop provisional rows locally.
    if (item.id > 0) this.http.delete(`${this.base}/${item.id}`).subscribe();
  }

  deleteAll(): void {
    this.items.set([]);
    this.unreadCount.set(0);
    this.http.delete(`${this.base}`).subscribe();
  }

  private applyRead(match: (it: NotificationItem) => boolean): void {
    const now = new Date().toISOString();
    let cleared = 0;
    this.items.update((list) =>
      list.map((it) => {
        if (match(it) && it.read_at === null) {
          cleared++;
          return { ...it, read_at: now };
        }
        return it;
      }),
    );
    if (cleared) this.unreadCount.update((c) => Math.max(0, c - cleared));
  }
}
