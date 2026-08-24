import { Component, DestroyRef, inject, input, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { auditTime } from 'rxjs/operators';
import { DeviceSocketService } from '../../services/device.socket.service';
import {
  HistoryService,
  rangeFrom,
  type RangeKey,
  type CommandView,
} from '../../services/history.service';

// The whole-home command feed (F18.7).
//
// This is the screen that answers "why did the pump run at 3am" — which is asked *before* you know
// which device to open, and is why it lives on the dashboard rather than on a device page. The
// device page shows the same feed filtered by deviceId, not a second implementation.

const SOURCES = ['rule', 'manual', 'scene', 'pipeline', 'phase', 'device', 'system'] as const;
const STATUSES = ['ok', 'error', 'timeout', 'sent'] as const;

@Component({
  selector: 'app-activity-feed',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatMenuModule],
  templateUrl: './activity-feed.component.html',
  styleUrls: ['./activity-feed.component.css'],
})
export class ActivityFeedComponent {
  /** Narrows the feed to one device — the device page passes this, the dashboard does not. */
  deviceId = input<number | undefined>(undefined);
  pageSize = input<number>(12);

  private history = inject(HistoryService);
  private destroyRef = inject(DestroyRef);
  private socket = inject(DeviceSocketService);

  readonly sources = SOURCES;
  readonly statuses = STATUSES;

  range = signal<RangeKey>('7d');
  source = signal<string | undefined>(undefined);
  status = signal<string | undefined>(undefined);
  commands = signal<CommandView[]>([]);
  nextBefore = signal<number | null>(null);
  loading = signal(false);
  /**
   * True once the reader has paged past the first screen.
   *
   * Live refresh reloads page one, which would silently throw away everything they had scrolled
   * to — so once they have paged, new rows wait until they change a filter. It is the same reason
   * `loadMore` pages by `nextBefore` rather than by offset.
   */
  private paged = signal(false);
  /** Lit while a socket event has landed but the debounce has not fired yet. */
  live = signal(false);

  constructor() {
    effect(() => {
      // Read every filter so the effect re-runs when any of them changes.
      this.range();
      this.source();
      this.status();
      this.deviceId();
      this.paged.set(false);
      this.reload();
    });

    // Real-time. Every command that reaches `device_commands` also produces one of these three:
    // pending on dispatch, update when the ack lands, failed when it does not.
    //
    // auditTime, NOT debounceTime. debounce waits for a gap in the stream, and this stream has no
    // gaps — telemetry lands every few hundred ms on a live stack, so the window never closed and
    // the feed never refreshed once. audit emits the latest event at most once per interval and
    // always fires while events flow, which is what "at most one reload every couple of seconds"
    // actually needs.
    merge(
      this.socket.actionStatePending$,
      this.socket.actionStateUpdate$,
      this.socket.actionStateFailed$,
    )
      .pipe(auditTime(2000), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.paged() || this.loading()) return;
        this.live.set(true);
        this.reload();
        setTimeout(() => this.live.set(false), 900);
      });
  }

  private query(before?: number) {
    return {
      deviceId: this.deviceId(),
      from: rangeFrom(this.range()),
      source: this.source(),
      status: this.status(),
      limit: this.pageSize(),
      before,
    };
  }

  private reload(): void {
    this.loading.set(true);
    this.history
      .commands(this.query())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.commands.set(page.commands);
          this.nextBefore.set(page.nextBefore);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  /**
   * Append the next page.
   *
   * Cursor-based, not offset-based: the feed is ordered by descending id and new commands arrive
   * while you read, so an offset would re-show rows that shifted down. `nextBefore` is the last id
   * on the page, which is stable whatever arrives above it.
   */
  loadMore(): void {
    const before = this.nextBefore();
    if (before === null || this.loading()) return;
    this.paged.set(true);
    this.loading.set(true);
    this.history
      .commands(this.query(before))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.commands.update((rows) => [...rows, ...page.commands]);
          this.nextBefore.set(page.nextBefore);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  setRange(r: RangeKey): void {
    this.range.set(r);
  }

  setSource(s: string | undefined): void {
    this.source.set(s);
  }

  setStatus(s: string | undefined): void {
    this.status.set(s);
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
      case 'phase':
        return 'var(--stage-exec)';
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

  /**
   * What raised it, in words.
   *
   * `source_label` is denormalised text captured at dispatch, so it still reads correctly after
   * the rule that raised it was renamed or deleted — which is exactly when you are looking.
   */
  describe(c: CommandView): string {
    if (c.sourceLabel) return c.sourceLabel;
    if (c.source === 'device') return 'reported by the device';
    if (c.source === 'manual') return 'you';
    return '';
  }

  /** A held command shows what it was told to hold for; the release arrives as its own row. */
  hold(c: CommandView): string {
    return c.durationSeconds ? `${c.durationSeconds}s` : '';
  }
}
