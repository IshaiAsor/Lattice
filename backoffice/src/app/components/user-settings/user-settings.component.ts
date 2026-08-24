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
  type MyRetentionView,
  type UsageView,
} from '../../services/retention.service';

// Settings → Data & storage (the F5.10 shell, scoped).
//
// Deliberately only the Data & storage section: Account, Notifications and Appearance are listed
// so the page has its real shape, but building them is F5.10 proper and not part of this work.

interface KindMeta {
  kind: DataKind;
  label: string;
  icon: string;
  color: string;
  blurb: string;
}

const KINDS: KindMeta[] = [
  {
    kind: 'scalar',
    label: 'Sensor readings',
    icon: 'show_chart',
    color: 'var(--primary)',
    blurb: 'Every reading your sensors have taken.',
  },
  {
    kind: 'frame',
    label: 'Camera frames',
    icon: 'photo_camera',
    color: 'var(--stage-vlm)',
    blurb: 'Full-resolution images. Usually the largest thing you keep.',
  },
  {
    kind: 'command',
    label: 'Commands',
    icon: 'bolt',
    color: 'var(--stage-llm)',
    blurb: 'Every command sent to a device, and whether it landed.',
  },
  {
    kind: 'device_event',
    label: 'Device events',
    icon: 'power',
    color: 'var(--stage-digest)',
    blurb: 'Online/offline, firmware and faults per device.',
  },
];

/** The choices offered in the UI. 0 is Forever — never "delete immediately". */
const CHOICES = [0, 7, 14, 30, 90, 180, 365];

@Component({
  selector: 'app-user-settings',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './user-settings.component.html',
  styleUrls: ['./user-settings.component.css'],
})
export class UserSettingsComponent {
  private retention = inject(RetentionService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly kinds = KINDS;
  readonly choices = CHOICES;

  /**
   * Whether a choice is above the admin's ceiling for this kind.
   *
   * The window was already clamped at prune time and the page said so afterwards — but an
   * over-ceiling chip still rendered as selected, so the page read as though the ceiling had been
   * overridden. Offering only what can actually take effect is the honest version.
   *
   * `0` is Forever, which is the LARGEST value despite being numerically the smallest — so it is
   * blocked by any ceiling at all, the same rule the worker's clampDays applies.
   */
  exceedsCap(days: number, maxDays: number | null): boolean {
    if (maxDays === null) return false;
    return days === 0 || days > maxDays;
  }
  readonly formatBytes = formatBytes;
  readonly formatDays = formatDays;

  policies = signal<MyRetentionView[]>([]);
  usage = signal<UsageView | null>(null);
  loading = signal(true);

  constructor() {
    this.load();
  }

  private load(): void {
    forkJoin({ mine: this.retention.mine(), usage: this.retention.myUsage() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.policies.set(r.mine);
          this.usage.set(r.usage);
          this.loading.set(false);
        },
        error: () => {
          this.snack.open('Could not load your data settings', 'Dismiss', { duration: 4000 });
          this.loading.set(false);
        },
      });
  }

  for(kind: DataKind): MyRetentionView | undefined {
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

  totalBytes(): number {
    const u = this.usage();
    if (!u) return 0;
    return u.frames.bytes + u.readings.bytes + u.commands.bytes + u.events.bytes;
  }

  /** Share of the total, for the storage bar and the "this is the dial that matters" hint. */
  share(kind: DataKind): number {
    const total = this.totalBytes();
    return total === 0 ? 0 : (this.usageFor(kind) / total) * 100;
  }

  set(kind: DataKind, rawDays: number): void {
    this.retention
      .setMine(kind, { rawDays })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.policies.set(rows);
          this.snack.open('Saved', undefined, { duration: 1500 });
        },
        error: (e: { error?: { error?: string } }) =>
          this.snack.open(e.error?.error ?? 'Could not save', 'Dismiss', { duration: 4000 }),
      });
  }

  /** Reset DELETES the override, so this user follows future changes to the default too. */
  reset(kind: DataKind): void {
    this.retention
      .resetMine(kind)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.policies.set(rows);
          this.snack.open('Back to the platform default', undefined, { duration: 1800 });
        },
        error: () => this.snack.open('Could not reset', 'Dismiss', { duration: 4000 }),
      });
  }

  colorFor(kind: DataKind): string {
    return KINDS.find((k) => k.kind === kind)?.color ?? 'var(--primary)';
  }
}
