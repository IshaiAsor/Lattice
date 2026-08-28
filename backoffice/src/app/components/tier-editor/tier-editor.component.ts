import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import {
  RetentionTiersService,
  bucketCost,
  type BucketView,
  type TierView,
} from '../../services/retention-tiers.service';
import {
  formatBytes,
  formatDays,
  type DataKind,
  type UsageBucket,
} from '../../services/retention.service';
import { CustomBucketDialogComponent } from '../custom-bucket-dialog/custom-bucket-dialog.component';

// One tier list, editable. Used by the admin page (the platform list, with ceilings) and by
// Settings → Data & storage (a user's own list), because they are the same thing at two scopes.
//
// The rules are enforced by the server — `assertTierList` in @lattice/retention — and this only
// mirrors the ones a person needs to see BEFORE they press Save: raw is first and cannot be
// removed, the chain has to divide, and the list has a length limit. Anything this lets through is
// refused with a readable reason, which is the right way round: a client-side rule that disagreed
// with the server would be worse than none.

const CHOICES = [0, 1, 7, 14, 30, 90, 180, 365, 730];

@Component({
  selector: 'app-tier-editor',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './tier-editor.component.html',
  styleUrls: ['./tier-editor.component.css'],
})
export class TierEditorComponent {
  private tiersApi = inject(RetentionTiersService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  /** The list being edited. */
  tiers = input.required<TierView[]>();
  /** The catalog, so the bucket select can offer every size including custom ones. */
  buckets = input.required<BucketView[]>();
  kind = input.required<DataKind>();
  /** The finest SUMMARY allowed. Never binds raw — see the API. */
  minBucket = input<string>('raw');
  /**
   * Platform ceilings per bucket, when editing a list that is not the platform's.
   *
   * Left empty by the admin page on purpose: the platform list IS the ceiling, so clamping it
   * against itself would refuse an admin raising their own limit.
   */
  ceilings = input<Record<string, number | null>>({});
  /**
   * What each bucket is ACTUALLY holding right now, keyed by catalog code (F18.22).
   *
   * The cost line beside it is a prediction — `86400 / seconds` rows per sensor per day — and a
   * prediction cannot tell you whether a tier is earning its keep. This can: it is the only place
   * raw and its own summaries appear on one screen in the same units, which is the trade a tier
   * list exists to make.
   */
  usage = input<Record<string, UsageBucket>>({});
  disabled = input<boolean>(false);

  changed = output<TierView[]>();

  readonly choices = CHOICES;
  readonly formatDays = formatDays;
  readonly formatBytes = formatBytes;
  readonly bucketCost = bucketCost;

  /** Local working copy, so a half-finished edit is not pushed on every keystroke. */
  draft = signal<TierView[] | null>(null);
  saving = signal(false);

  rows = computed(() => this.draft() ?? this.tiers());

  bucketFor(code: string): BucketView | undefined {
    return this.buckets().find((b) => b.code === code);
  }

  secondsOf(code: string): number {
    return this.bucketFor(code)?.seconds ?? 0;
  }

  /** Rows sorted by size, which is the order the fold chain uses regardless of stored position. */
  sorted = computed(() =>
    [...this.rows()].sort((a, b) => this.secondsOf(a.bucket) - this.secondsOf(b.bucket)),
  );

  isRaw(t: TierView): boolean {
    return t.bucket === 'raw';
  }

  /**
   * Sizes that may still be added: not already in the list, allowed for this kind, and not finer
   * than the platform minimum.
   */
  available = computed<BucketView[]>(() => {
    const used = new Set(this.rows().map((t) => t.bucket));
    const floor = this.secondsOf(this.minBucket());
    const k = this.kind();
    return this.buckets().filter((b) => {
      if (used.has(b.code)) return false;
      if (b.seconds === 0) return false; // raw is mandatory and always present
      if (k === 'frame') return false; // a frame has nothing to summarise
      if (k === 'command' || k === 'device_event') return b.seconds % 86_400 === 0;
      return b.seconds >= floor;
    });
  });

  /**
   * The chain check, mirrored client-side so the refusal appears as you build the list rather than
   * on Save. The server is still the authority.
   */
  chainBreak = computed<string | null>(() => {
    const rollups = this.sorted().filter((t) => this.secondsOf(t.bucket) > 0);
    for (let i = 1; i < rollups.length; i++) {
      const parent = this.secondsOf(rollups[i]!.bucket);
      const child = this.secondsOf(rollups[i - 1]!.bucket);
      if (parent % child !== 0) {
        const ratio = Math.round((parent / child) * 100) / 100;
        return `${rollups[i]!.bucket} cannot fold from ${rollups[i - 1]!.bucket} — it is ${ratio}× as long, not a whole number of them.`;
      }
    }
    return null;
  });

  /** Total rollup rows per sensor per day across the list — the cost of this configuration. */
  totalRowsPerDay = computed(() =>
    Math.round(
      this.rows().reduce((n, t) => n + (this.bucketFor(t.bucket)?.rowsPerDay ?? 0), 0) * 100,
    ) / 100,
  );

  /**
   * Which usage figure a tier row reads.
   *
   * For scalars it is the bucket itself — `sensor_rollup` has a `bucket` column, so the mapping is
   * literal. For commands and device events the summaries live in ONE DATE-keyed table with no
   * bucket column, so the rows are reported under `1d` (one row is one day, factually) while the
   * tier governing them may be any whole-day size the list carries. Reading a literal `1d` would
   * show a `1w` tier as empty and simultaneously claim its rows were orphaned.
   */
  usageKeyFor(bucket: string): string {
    const k = this.kind();
    if (k !== 'command' && k !== 'device_event') return bucket;
    const seconds = this.secondsOf(bucket);
    return seconds > 0 && seconds % 86_400 === 0 ? '1d' : bucket;
  }

  /** What this bucket is holding, or null when nothing has been written under it yet. */
  storedIn(bucket: string): UsageBucket | null {
    const u = this.usage()[this.usageKeyFor(bucket)];
    return u && u.rows > 0 ? u : null;
  }

  /**
   * Every bucket holding rows that this list does not configure.
   *
   * Worth naming rather than silently omitting: a tier removed this morning is still costing what
   * it cost, and the storage figure above will not drop until the next cleanup sweeps it.
   */
  orphaned = computed<{ bucket: string; usage: UsageBucket }[]>(() => {
    const covered = new Set(this.rows().map((t) => this.usageKeyFor(t.bucket)));
    return Object.entries(this.usage())
      .filter(([bucket, u]) => !covered.has(bucket) && u.rows > 0)
      .map(([bucket, usage]) => ({ bucket, usage }));
  });

  /** Rows stored across every bucket in this list, so the footer totals what the rows show. */
  totalStored = computed(() => {
    const covered = new Set(this.rows().map((t) => this.usageKeyFor(t.bucket)));
    return [...covered].reduce((n, key) => n + (this.usage()[key]?.rows ?? 0), 0);
  });

  ceilingFor(bucket: string): number | null {
    return this.ceilings()[bucket] ?? null;
  }

  /** `0` is forever and therefore above every finite ceiling, however small it reads. */
  aboveCeiling(t: TierView): boolean {
    const c = this.ceilingFor(t.bucket);
    if (c === null) return false;
    return t.keepDays === 0 || t.keepDays > c;
  }

  private emit(next: TierView[]): void {
    const positioned = next.map((t, i) => ({ ...t, position: i }));
    this.draft.set(positioned);
    this.changed.emit(positioned);
  }

  setKeep(bucket: string, days: number): void {
    this.emit(this.rows().map((t) => (t.bucket === bucket ? { ...t, keepDays: days } : t)));
  }

  add(bucket: string): void {
    this.emit([...this.rows(), { bucket, keepDays: 0, position: this.rows().length }]);
  }

  remove(bucket: string): void {
    if (bucket === 'raw') return; // mandatory: it sets how long the readings themselves are kept
    this.emit(this.rows().filter((t) => t.bucket !== bucket));
  }

  /**
   * "＋ Custom size…", offered at the point the list does not have what someone wants.
   *
   * The dialog resolves a duplicate to the existing catalog row rather than erroring, so two people
   * asking for 90 minutes get the same 5400 seconds.
   */
  async addCustom(): Promise<void> {
    const ref = this.dialog.open(CustomBucketDialogComponent, {
      width: '460px',
      panelClass: ['glass-dialog', 'solid-dialog'],
      // Focus the panel, not a button: an auto-focused Cancel next to a destructive action reads as
      // a choice already made, and its ring makes the two buttons look mismatched.
      autoFocus: 'dialog',
      data: { kind: this.kind(), minBucket: this.minBucket(), buckets: this.buckets() },
    });
    const created = (await firstValueFrom(ref.afterClosed())) as BucketView | undefined;
    if (!created) return;
    this.snack.open(`${created.label} is available`, undefined, { duration: 2500 });
    // The parent reloads the catalog; adding it here too means it lands in the list immediately.
    if (!this.rows().some((t) => t.bucket === created.code)) this.add(created.code);
  }

  /** Discard local edits — used by the parent after a failed save. */
  reset(): void {
    this.draft.set(null);
  }
}
