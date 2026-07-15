import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDialog } from '@angular/material/dialog';
import { SHARED_MATERIAL } from '../../shared-ui';
import {
  NotificationsService,
  NotificationPreference,
  NotificationItem,
} from '../../services/notifications.service';
import { PushSubscriptionService } from '../../services/push-subscription.service';
import { ConfirmDialogComponent } from '../admin-device-config/confirm-dialog.component';

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
// Channels with no configured provider yet — shown but not selectable.
const UNAVAILABLE_CHANNELS = new Set(['sms']);

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
  private pushSvc = inject(PushSubscriptionService);
  private dialog = inject(MatDialog);

  readonly items = this.svc.items;
  readonly unreadCount = this.svc.unreadCount;
  readonly channels = CHANNEL_ORDER.map((c) => ({ key: c, ...CHANNEL_META[c] }));

  isChannelUnavailable(channel: string): boolean {
    return UNAVAILABLE_CHANNELS.has(channel);
  }

  readonly prefRows = signal<PrefRow[]>([]);
  readonly savingPrefs = signal(false);
  readonly hasUnread = computed(() => this.items().some((i) => i.read_at === null));
  readonly hasItems = computed(() => this.items().length > 0);

  readonly pushSupported = signal(false);
  readonly pushEnabled = signal(false);
  readonly pushBusy = signal(false);

  ngOnInit(): void {
    this.svc.connectLive();
    this.svc.loadInbox();
    this.svc.refreshUnread();
    this.loadPreferences();

    this.pushSupported.set(this.pushSvc.isSupported());
    if (this.pushSupported()) {
      this.pushSvc.getSubscriptionState().then((s) => this.pushEnabled.set(s === 'subscribed'));
    }
  }

  enablePush(): void {
    this.pushBusy.set(true);
    this.pushSvc
      .enable()
      .then(() => this.pushEnabled.set(true))
      .catch((err) => console.error('enable push failed', err))
      .finally(() => this.pushBusy.set(false));
  }

  disablePush(): void {
    this.pushBusy.set(true);
    this.pushSvc
      .disable()
      .then(() => this.pushEnabled.set(false))
      .finally(() => this.pushBusy.set(false));
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
    if (cell.locked || this.isChannelUnavailable(cell.channel)) return;
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

  deleteItem(item: NotificationItem, ev: Event): void {
    ev.stopPropagation(); // don't also trigger markRead on the row
    this.svc.deleteOne(item);
  }

  clearAll(): void {
    this.dialog
      .open(ConfirmDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          title: 'Clear notifications',
          message: 'Delete all notifications? This cannot be undone.',
          confirmLabel: 'Clear all',
        },
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (confirmed) this.svc.deleteAll();
      });
  }

  iconFor(eventType: string): string {
    return EVENT_META[eventType]?.icon ?? 'notifications';
  }
}
