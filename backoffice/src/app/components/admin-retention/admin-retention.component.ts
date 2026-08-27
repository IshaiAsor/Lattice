import { Component, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import {
  RetentionService,
  formatBytes,
  formatDays,
  type DataKind,
  type UsageView,
} from '../../services/retention.service';
import {
  RetentionTiersService,
  type BucketView,
  type PolicyTiersView,
  type ScheduleView,
  type TierView,
} from '../../services/retention-tiers.service';
import { TierEditorComponent } from '../tier-editor/tier-editor.component';
import { RetentionApplyDialogComponent } from '../retention-apply-dialog/retention-apply-dialog.component';

// Admin → Data Retention. The platform layer: the tier list every user starts on, and the ceilings
// none of them may exceed. A user's own list lives in Settings → Data & storage.
//
// Phase 2 replaced the three fixed windows with a tier LIST per kind (F18.9), so this page is now
// four tier editors plus the ceiling column. The rules — chain divisibility, the raw floor, the
// per-kind limits — are the server's; this page shows them as you build.

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

const CEILING_CHOICES: (number | null)[] = [null, 7, 14, 30, 90, 180, 365];

@Component({
  selector: 'app-admin-retention',
  standalone: true,
  imports: [CommonModule, MatIconModule, RouterLink, TierEditorComponent],
  templateUrl: './admin-retention.component.html',
  styleUrls: ['./admin-retention.component.css'],
})
export class AdminRetentionComponent {
  private retention = inject(RetentionService);
  private tiersApi = inject(RetentionTiersService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly kinds = KINDS;
  readonly ceilingChoices = CEILING_CHOICES;
  readonly formatBytes = formatBytes;
  readonly formatDays = formatDays;

  policies = signal<PolicyTiersView[]>([]);
  buckets = signal<BucketView[]>([]);
  usage = signal<UsageView | null>(null);
  schedule = signal<ScheduleView | null>(null);
  loading = signal(true);
  /** Per-kind pending edits, so a half-finished list is not saved on every chip press. */
  drafts = signal<Record<string, TierView[]>>({});

  constructor() {
    this.load();
  }

  private load(): void {
    forkJoin({
      policies: this.tiersApi.policyTiers(),
      buckets: this.tiersApi.buckets(),
      usage: this.retention.platformUsage(),
      schedule: this.tiersApi.adminSchedule(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.policies.set(r.policies);
          this.buckets.set(r.buckets);
          this.usage.set(r.usage);
          this.schedule.set(r.schedule);
          this.drafts.set({});
          this.loading.set(false);
        },
        error: () => {
          this.snack.open('Could not load the retention policy', 'Dismiss', { duration: 4000 });
          this.loading.set(false);
        },
      });
  }

  /**
   * How often summaries are rebuilt, in words (F18.17).
   *
   * The cadence is DERIVED from the finest tier configured anywhere rather than set anywhere, which
   * is the point — and completely invisible unless the page says so. Adding a `15m` tier below
   * moves this line, with no redeploy.
   */
  cadenceLabel(): string {
    const s = this.schedule();
    if (!s) return '';
    if (s.rollupIntervalSeconds === null)
      return 'Summaries are rebuilt by the nightly cleanup — nothing finer than a day is configured.';
    const minutes = Math.round(s.rollupIntervalSeconds / 60);
    const every = minutes % 60 === 0 ? `${minutes / 60} hour` : `${minutes} minute`;
    const plural = minutes % 60 === 0 ? minutes / 60 !== 1 : minutes !== 1;
    const finest = s.finestBucket ? ` — the finest tier configured is ${s.finestBucket.label}` : '';
    return `Summaries are rebuilt every ${every}${plural ? 's' : ''}${finest}.`;
  }

  for(kind: DataKind): PolicyTiersView | undefined {
    return this.policies().find((p) => p.dataKind === kind);
  }

  tiersFor(kind: DataKind): TierView[] {
    return this.drafts()[kind] ?? this.for(kind)?.tiers ?? [];
  }

  /** The platform list IS the ceiling, so the editor is not clamped against one. */
  ceilingsFor(kind: DataKind): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const t of this.for(kind)?.tiers ?? []) out[t.bucket] = t.maxKeepDays;
    return out;
  }

  dirty(kind: DataKind): boolean {
    return this.drafts()[kind] !== undefined;
  }

  onTiersChanged(kind: DataKind, tiers: TierView[]): void {
    this.drafts.update((d) => ({ ...d, [kind]: tiers }));
  }

  discard(kind: DataKind): void {
    this.drafts.update((d) => {
      const next = { ...d };
      delete next[kind];
      return next;
    });
  }

  /**
   * Save the list, carrying each bucket's existing ceiling through.
   *
   * The response says who was affected: an admin lowering a ceiling below what someone chose trims
   * them on the next sweep and notifies them (F18.16), and the snack bar says so rather than
   * leaving that to be discovered.
   */
  save(kind: DataKind): void {
    const tiers = this.tiersFor(kind);
    const ceilings = this.ceilingsFor(kind);
    this.tiersApi
      .setPolicyTiers(kind, {
        tiers: tiers.map((t) => ({ ...t, maxKeepDays: ceilings[t.bucket] ?? null })),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.policies.set(r.policies);
          this.discard(kind);
          const n = r.affected?.length ?? 0;
          this.snack.open(
            n > 0
              ? `Saved — ${n} user${n === 1 ? '' : 's'} were above the new limit and have been notified`
              : 'Saved',
            undefined,
            { duration: n > 0 ? 5000 : 1500 },
          );
        },
        error: (e: { error?: { error?: string } }) =>
          this.snack.open(e.error?.error ?? 'Could not save', 'Dismiss', { duration: 6000 }),
      });
  }

  setCeiling(kind: DataKind, bucket: string, days: number | null): void {
    const policy = this.for(kind);
    if (!policy) return;
    const tiers = this.tiersFor(kind).map((t) => ({
      ...t,
      maxKeepDays: t.bucket === bucket ? days : (this.ceilingsFor(kind)[t.bucket] ?? null),
    }));
    // A ceiling below the platform's own default for that bucket is the invalid pair, so carry the
    // default down with it: the admin's intent ("nobody above 7 days") is unambiguous, and leaving
    // a stale 14 on screen would state a window the sweep was never going to honour.
    const adjusted = tiers.map((t) =>
      t.bucket === bucket && days !== null && (t.keepDays === 0 || t.keepDays > days)
        ? { ...t, keepDays: days }
        : t,
    );
    const lowered = adjusted.some((t, i) => t.keepDays !== tiers[i]!.keepDays);
    this.tiersApi
      .setPolicyTiers(kind, { tiers: adjusted })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.policies.set(r.policies);
          this.discard(kind);
          const n = r.affected?.length ?? 0;
          const parts: string[] = [];
          if (lowered) parts.push(`default lowered to ${formatDays(days)}`);
          if (n > 0) parts.push(`${n} user${n === 1 ? '' : 's'} notified`);
          this.snack.open(parts.length ? `Saved — ${parts.join(', ')}` : 'Saved', undefined, {
            duration: parts.length ? 5000 : 1500,
          });
        },
        error: (e: { error?: { error?: string } }) =>
          this.snack.open(e.error?.error ?? 'Could not save', 'Dismiss', { duration: 6000 }),
      });
  }

  toggleEnabled(kind: DataKind, enabled: boolean): void {
    this.tiersApi
      .setPolicyTiers(kind, { tiers: this.tiersFor(kind), enabled })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.policies.set(r.policies),
        error: (e: { error?: { error?: string } }) =>
          this.snack.open(e.error?.error ?? 'Could not save', 'Dismiss', { duration: 4000 }),
      });
  }

  /** Counts first, then runs — the dialog never offers a confirm above an unknown number. */
  cleanUpNow(): void {
    this.dialog
      .open(RetentionApplyDialogComponent, {
        width: '520px',
        panelClass: ['glass-dialog', 'solid-dialog'],
        // Focus the panel, not a button: an auto-focused Cancel next to a destructive action reads as
        // a choice already made, and its ring makes the two buttons look mismatched.
        autoFocus: 'dialog',
        data: { scope: 'admin' },
      })
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.load());
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
}
