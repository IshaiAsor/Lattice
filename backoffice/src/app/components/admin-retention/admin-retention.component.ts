import { Component, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import {
  RetentionService,
  formatBytes,
  formatDays,
  type DataKind,
  type RetentionPolicyView,
  type UsageView,
  type OverrideView,
} from '../../services/retention.service';

// Admin → Data Retention. The platform layer: the default every user starts on, and the ceiling
// none of them may exceed. A user's own window lives in Settings → Data & storage.

interface KindMeta {
  kind: DataKind;
  label: string;
  icon: string;
  color: string;
  table: string;
}

const KINDS: KindMeta[] = [
  {
    kind: 'scalar',
    label: 'Sensor readings',
    icon: 'show_chart',
    color: 'var(--primary)',
    table: 'sensor_history → sensor_rollup',
  },
  {
    kind: 'frame',
    label: 'Camera frames',
    icon: 'photo_camera',
    color: 'var(--stage-vlm)',
    table: 'camera_frame_history',
  },
  {
    kind: 'command',
    label: 'Commands',
    icon: 'bolt',
    color: 'var(--stage-llm)',
    table: 'device_commands → command_rollup_daily',
  },
  {
    kind: 'device_event',
    label: 'Device events',
    icon: 'power',
    color: 'var(--stage-digest)',
    table: 'device_events → device_availability_daily',
  },
];

const CHOICES = [0, 7, 14, 30, 90, 180, 365];

@Component({
  selector: 'app-admin-retention',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './admin-retention.component.html',
  styleUrls: ['./admin-retention.component.css'],
})
export class AdminRetentionComponent {
  private retention = inject(RetentionService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly kinds = KINDS;
  readonly choices = CHOICES;
  readonly formatBytes = formatBytes;
  readonly formatDays = formatDays;

  policies = signal<RetentionPolicyView[]>([]);
  usage = signal<UsageView | null>(null);
  overrides = signal<OverrideView[]>([]);
  loading = signal(true);

  constructor() {
    this.load();
  }

  private load(): void {
    forkJoin({
      policies: this.retention.policies(),
      usage: this.retention.platformUsage(),
      overrides: this.retention.overrides(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.policies.set(r.policies);
          this.usage.set(r.usage);
          this.overrides.set(r.overrides);
          this.loading.set(false);
        },
        error: () => {
          this.snack.open('Could not load the retention policy', 'Dismiss', { duration: 4000 });
          this.loading.set(false);
        },
      });
  }

  for(kind: DataKind): RetentionPolicyView | undefined {
    return this.policies().find((p) => p.dataKind === kind);
  }

  usageFor(kind: DataKind): number {
    const u = this.usage();
    if (!u) return 0;
    switch (kind) {
      case 'frame':
        return u.frames.bytes;
      case 'scalar':
        return u.readings.bytes;
      case 'command':
        return u.commands.bytes;
      default:
        return u.events.bytes;
    }
  }

  rowsFor(kind: DataKind): number {
    const u = this.usage();
    if (!u) return 0;
    switch (kind) {
      case 'frame':
        return u.frames.rows;
      case 'scalar':
        return u.readings.rows;
      case 'command':
        return u.commands.rows;
      default:
        return u.events.rows;
    }
  }

  totalBytes(): number {
    const u = this.usage();
    if (!u) return 0;
    return u.frames.bytes + u.readings.bytes + u.commands.bytes + u.events.bytes;
  }

  share(kind: DataKind): number {
    const total = this.totalBytes();
    return total === 0 ? 0 : (this.usageFor(kind) / total) * 100;
  }

  overridesFor(kind: DataKind): OverrideView[] {
    return this.overrides().filter((o) => o.dataKind === kind);
  }

  private save(
    kind: DataKind,
    body: Record<string, number | boolean | null>,
    note?: string,
  ): void {
    this.retention
      .updatePolicy(kind, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.policies.set(rows);
          this.snack.open(note ?? 'Policy saved', undefined, { duration: note ? 3500 : 1500 });
        },
        error: (e: { error?: { error?: string } }) =>
          this.snack.open(e.error?.error ?? 'Could not save', 'Dismiss', { duration: 4000 }),
      });
  }

  /**
   * Whether this default would sit above the ceiling — which the worker silently clamps, so the
   * page would claim a window nobody actually gets.
   *
   * `0` is Forever and therefore above every finite ceiling, however small the number reads.
   */
  aboveCeiling(kind: DataKind, days: number): boolean {
    const ceiling = this.for(kind)?.maxRawDays ?? null;
    if (ceiling === null) return false;
    return days === 0 || days > ceiling;
  }

  setDefault(kind: DataKind, days: number): void {
    if (this.aboveCeiling(kind, days)) return;
    this.save(kind, { defaultRawDays: days });
  }

  /**
   * Null clears the ceiling — uncapped, which is NOT the same as a ceiling of 0.
   *
   * Lowering the ceiling under the current default is the one way to reach the invalid pair, so it
   * carries the default down with it in the same request rather than being refused: the admin's
   * intent ("nobody above 7 days") is unambiguous, and leaving a stale 14 on screen would state a
   * window the worker was never going to honour.
   */
  setCeiling(kind: DataKind, days: number | null): void {
    if (days === null || !this.currentDefaultExceeds(kind, days)) {
      this.save(kind, { maxRawDays: days });
      return;
    }
    this.save(
      kind,
      { maxRawDays: days, defaultRawDays: days },
      `Default lowered to ${formatDays(days)} to stay within the new ceiling`,
    );
  }

  /** Would the CURRENT default breach this proposed ceiling? */
  private currentDefaultExceeds(kind: DataKind, ceiling: number): boolean {
    const current = this.for(kind)?.defaultRawDays ?? 0;
    return current === 0 || current > ceiling;
  }

  toggleEnabled(kind: DataKind, enabled: boolean): void {
    this.save(kind, { enabled });
  }
}
