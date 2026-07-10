import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { SHARED_MATERIAL } from '../../shared-ui';
import {
  NotificationsService,
  NotificationPreference,
  NotificationItem,
} from '../../services/notifications.service';

// Friendly labels + icons for the event types + channels the api exposes.
const EVENT_META: Record<string, { label: string; icon: string }> = {
  emergency: { label: 'Emergency alerts', icon: 'warning' },
  rule_fired: { label: 'Automation fired', icon: 'bolt' },
  device_offline: { label: 'Device offline', icon: 'wifi_off' },
  ota_available: { label: 'Firmware updates', icon: 'system_update' },
};
const CHANNEL_META: Record<string, { label: string; icon: string }> = {
  in_app: { label: 'In-app', icon: 'notifications' },
  email: { label: 'Email', icon: 'mail' },
  push: { label: 'Push', icon: 'phone_iphone' },
  sms: { label: 'SMS', icon: 'sms' },
};
const CHANNEL_ORDER = ['in_app', 'email', 'push', 'sms'];

interface PrefRow {
  eventType: string;
  label: string;
  icon: string;
  cells: NotificationPreference[]; // ordered by CHANNEL_ORDER
}

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [SHARED_MATERIAL, MatTabsModule],
  templateUrl: './notifications.component.html',
  styleUrl: './notifications.component.css',
})
export class NotificationsComponent implements OnInit {
  private svc = inject(NotificationsService);

  readonly items = this.svc.items;
  readonly unreadCount = this.svc.unreadCount;
  readonly channels = CHANNEL_ORDER.map((c) => ({ key: c, ...CHANNEL_META[c] }));

  readonly prefRows = signal<PrefRow[]>([]);
  readonly savingPrefs = signal(false);
  readonly hasUnread = computed(() => this.items().some((i) => i.read_at === null));

  ngOnInit(): void {
    this.svc.connectLive();
    this.svc.loadInbox();
    this.svc.refreshUnread();
    this.loadPreferences();
  }

  private loadPreferences(): void {
    this.svc.getPreferences().subscribe((prefs) => this.prefRows.set(this.toRows(prefs)));
  }

  private toRows(prefs: NotificationPreference[]): PrefRow[] {
    const byEvent = new Map<string, NotificationPreference[]>();
    for (const p of prefs) {
      const list = byEvent.get(p.event_type) ?? [];
      list.push(p);
      byEvent.set(p.event_type, list);
    }
    return [...byEvent.entries()].map(([eventType, cells]) => ({
      eventType,
      label: EVENT_META[eventType]?.label ?? eventType,
      icon: EVENT_META[eventType]?.icon ?? 'notifications',
      cells: CHANNEL_ORDER.map(
        (ch) => cells.find((c) => c.channel === ch) as NotificationPreference,
      ).filter(Boolean),
    }));
  }

  togglePref(row: PrefRow, cell: NotificationPreference, enabled: boolean): void {
    if (cell.locked) return;
    this.savingPrefs.set(true);
    this.svc
      .setPreferences([{ channel: cell.channel, event_type: cell.event_type, enabled }])
      .subscribe({
        next: (prefs) => {
          this.prefRows.set(this.toRows(prefs));
          this.savingPrefs.set(false);
        },
        error: () => this.savingPrefs.set(false),
      });
  }

  markRead(item: NotificationItem): void {
    if (item.read_at === null) this.svc.markRead(item.id);
  }

  markAllRead(): void {
    this.svc.markAllRead();
  }

  iconFor(eventType: string): string {
    return EVENT_META[eventType]?.icon ?? 'notifications';
  }
}
