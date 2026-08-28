import { Component, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import {
  RetentionService,
  formatBytes,
  formatDays,
  usageForKind,
  type DataKind,
  type UsageBucket,
  type UsageView,
} from '../../services/retention.service';
import {
  RetentionTiersService,
  type BucketView,
  type MyTiersView,
  type TierView,
} from '../../services/retention-tiers.service';
import { TierEditorComponent } from '../tier-editor/tier-editor.component';
import { RetentionApplyDialogComponent } from '../retention-apply-dialog/retention-apply-dialog.component';
import { RetentionActivityComponent } from '../retention-activity/retention-activity.component';

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


@Component({
  selector: 'app-user-settings',
  standalone: true,
  imports: [CommonModule, MatIconModule, TierEditorComponent, RetentionActivityComponent],
  templateUrl: './user-settings.component.html',
  styleUrls: ['./user-settings.component.css'],
})
export class UserSettingsComponent {
  private retention = inject(RetentionService);
  private tiersApi = inject(RetentionTiersService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly kinds = KINDS;

  readonly formatBytes = formatBytes;
  readonly formatDays = formatDays;

  policies = signal<MyTiersView[]>([]);
  buckets = signal<BucketView[]>([]);
  usage = signal<UsageView | null>(null);
  loading = signal(true);
  /** Pending per-kind edits, so a half-built list is not saved on every chip press. */
  drafts = signal<Record<string, TierView[]>>({});

  constructor() {
    this.load();
  }

  load(): void {
    forkJoin({
      mine: this.tiersApi.mine(),
      buckets: this.tiersApi.buckets(),
      usage: this.retention.myUsage(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.policies.set(r.mine);
          this.buckets.set(r.buckets);
          this.usage.set(r.usage);
          this.drafts.set({});
          this.loading.set(false);
        },
        error: () => {
          this.snack.open('Could not load your data settings', 'Dismiss', { duration: 4000 });
          this.loading.set(false);
        },
      });
  }

  for(kind: DataKind): MyTiersView | undefined {
    return this.policies().find((p) => p.dataKind === kind);
  }

  usageFor(kind: DataKind): number {
    return usageForKind(this.usage(), kind).bytes;
  }

  /** What each bucket of this kind is holding, for the tier editor's per-row figures (F18.22). */
  bucketUsageFor(kind: DataKind): Record<string, UsageBucket> {
    return usageForKind(this.usage(), kind).buckets;
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

  tiersFor(kind: DataKind): TierView[] {
    return this.drafts()[kind] ?? this.for(kind)?.tiers ?? [];
  }

  /** Ceilings per bucket, so the editor can strike through a choice the platform will refuse. */
  ceilingsFor(kind: DataKind): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const t of this.for(kind)?.platformTiers ?? []) out[t.bucket] = t.maxKeepDays;
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

  save(kind: DataKind): void {
    this.tiersApi
      .setMine(kind, this.tiersFor(kind))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.policies.set(rows);
          this.discard(kind);
          this.snack.open('Saved', undefined, { duration: 1500 });
        },
        // The refusal text is the useful part — "the 90m tier cannot fold from 1h; use 30m or 45m
        // below it" says what to do next, which a generic "could not save" never does.
        error: (e: { error?: { error?: string } }) =>
          this.snack.open(e.error?.error ?? 'Could not save', 'Dismiss', { duration: 6000 }),
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
        data: { scope: 'user' },
      })
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.load());
  }

  /** Reset DELETES the rows, so this user follows future changes to the platform list too. */
  reset(kind: DataKind): void {
    this.tiersApi
      .resetMine(kind)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.policies.set(rows);
          this.discard(kind);
          this.snack.open('Back to the platform default', undefined, { duration: 1800 });
        },
        error: () => this.snack.open('Could not reset', 'Dismiss', { duration: 4000 }),
      });
  }

  colorFor(kind: DataKind): string {
    return KINDS.find((k) => k.kind === kind)?.color ?? 'var(--primary)';
  }
}
