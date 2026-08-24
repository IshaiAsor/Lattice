import { Component, DestroyRef, inject, input, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import {
  HistoryService,
  rangeFrom,
  type RangeKey,
  type AvailabilityView,
  type DeviceEventView,
  type CommandView,
} from '../../services/history.service';

// The device page's Health tab (F18.3).
//
// Scoped to what happened *to* this device: availability, its own timeline, and the last few
// commands it received. The whole-home command feed lives on the dashboard — "why did the pump run
// at 3am" is asked before you know which device to open, so a per-device page is the wrong place
// to answer it. What is here is the same feed filtered, not a second implementation.

interface Band {
  left: number;
  width: number;
  kind: 'on' | 'off';
}

@Component({
  selector: 'app-device-health',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, RouterModule],
  templateUrl: './device-health.component.html',
  styleUrls: ['./device-health.component.css'],
})
export class DeviceHealthComponent {
  deviceId = input.required<number>();

  private history = inject(HistoryService);
  private destroyRef = inject(DestroyRef);

  range = signal<RangeKey>('7d');
  loading = signal(false);
  availability = signal<AvailabilityView | null>(null);
  events = signal<DeviceEventView[]>([]);
  commands = signal<CommandView[]>([]);

  constructor() {
    // Refetch whenever the device or the range changes. Both are signals, so this is the whole
    // wiring — no ngOnChanges, no manual re-subscribe.
    effect(() => {
      const id = this.deviceId();
      const from = rangeFrom(this.range());
      if (!id) return;
      this.load(id, from);
    });
  }

  private load(deviceId: number, from: string): void {
    this.loading.set(true);
    forkJoin({
      availability: this.history.availability(deviceId, { from }),
      events: this.history.deviceEvents(deviceId, { from, limit: 40 }),
      commands: this.history.commands({ deviceId, from, limit: 6 }),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.availability.set(r.availability);
          this.events.set(r.events);
          this.commands.set(r.commands.commands);
          this.loading.set(false);
        },
        error: () => {
          // The page still renders its empty states; a failed history fetch must not blank the
          // device page a user opened to do something else.
          this.loading.set(false);
        },
      });
  }

  setRange(r: RangeKey): void {
    this.range.set(r);
  }

  /**
   * Daily uptime as proportional bands.
   *
   * Built from the daily rollup rather than from raw events: a day with no events is not a day
   * with no data, it is a full day in whatever state the device was already in, and the rollup is
   * where that has already been worked out.
   */
  bands = signal<Band[]>([]);

  private bandEffect = effect(() => {
    const a = this.availability();
    if (!a || a.days.length === 0) {
      this.bands.set([]);
      return;
    }
    const total = a.days.reduce((s, d) => s + d.onlineSeconds + d.offlineSeconds, 0);
    if (total === 0) {
      this.bands.set([]);
      return;
    }
    const out: Band[] = [];
    let cursor = 0;
    for (const d of a.days) {
      for (const [secs, kind] of [
        [d.onlineSeconds, 'on'],
        [d.offlineSeconds, 'off'],
      ] as const) {
        if (secs <= 0) continue;
        const width = (secs / total) * 100;
        out.push({ left: cursor, width, kind });
        cursor += width;
      }
    }
    this.bands.set(out);
  });

  eventIcon(kind: string): string {
    switch (kind) {
      case 'online':
        return 'power';
      case 'offline':
        return 'power_off';
      case 'firmware':
        return 'system_update_alt';
      case 'fault':
        return 'warning';
      default:
        return 'settings';
    }
  }

  eventColor(kind: string): string {
    switch (kind) {
      case 'online':
        return 'var(--online)';
      case 'offline':
        return 'var(--offline)';
      case 'fault':
        return 'var(--error)';
      case 'firmware':
        return 'var(--primary)';
      default:
        return 'var(--text-muted)';
    }
  }

  eventTitle(e: DeviceEventView): string {
    switch (e.kind) {
      case 'online':
        return 'Came back online';
      case 'offline':
        return 'Went offline';
      case 'firmware':
        return 'Firmware confirmed';
      case 'fault':
        return 'Fault reading';
      default:
        return 'Configuration applied';
    }
  }

  eventDetail(e: DeviceEventView): string {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    if (e.kind === 'firmware') return `${e.from ?? 'unknown'} → ${e.to}`;
    if (e.kind === 'fault') {
      const action = typeof d['action'] === 'string' ? d['action'] : 'a reading';
      return e.to ? `${action} — ${e.to}` : action;
    }
    // Only the reaper sets this: it means nothing told us the device went, we inferred it from
    // missed heartbeats. Worth saying, because it is the case that looks like a clean shutdown
    // and is not one.
    if (e.kind === 'offline' && d['reason'] === 'no-last-will')
      return 'no Last-Will — caught by the liveness reaper';
    return '';
  }

  sourceColor(source: string): string {
    switch (source) {
      case 'rule':
        return 'var(--stage-llm)';
      case 'manual':
        return 'var(--primary)';
      case 'scene':
        return 'var(--stage-vlm)';
      case 'pipeline':
        return 'var(--stage-digest)';
      default:
        return 'var(--text-muted)';
    }
  }

  statusColor(status: string): string {
    switch (status) {
      case 'ok':
        return 'var(--online)';
      case 'error':
        return 'var(--error)';
      case 'timeout':
        return 'var(--warning)';
      default:
        return 'var(--text-muted)';
    }
  }
}
