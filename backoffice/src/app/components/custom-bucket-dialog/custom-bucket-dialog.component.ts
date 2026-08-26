import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import {
  RetentionTiersService,
  boundaryPreview,
  type BucketView,
} from '../../services/retention-tiers.service';
import type { DataKind } from '../../services/retention.service';

// "＋ Custom size…" — opened from the bottom of the tier editor's add row, so a person meets it
// exactly when the list does not have what they want.
//
// The refusals are worth as much as the input. A size is rejected for one of three reasons, and
// each one is stated in the vocabulary of the rule that fired rather than as "invalid": below a
// minute, not an even division of a day, or below the platform's own minimum. The server enforces
// all three; this shows them before the round trip, and the live boundary preview is what makes the
// division rule obvious without explaining it.

export interface CustomBucketData {
  kind: DataKind;
  minBucket: string;
  buckets: BucketView[];
}

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_SECONDS: Record<Unit, number> = { minutes: 60, hours: 3600, days: 86_400 };

@Component({
  selector: 'app-custom-bucket-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatDialogModule],
  templateUrl: './custom-bucket-dialog.component.html',
  styleUrls: ['./custom-bucket-dialog.component.css'],
})
export class CustomBucketDialogComponent {
  private api = inject(RetentionTiersService);
  private ref = inject(MatDialogRef<CustomBucketDialogComponent>);
  readonly data = inject<CustomBucketData>(MAT_DIALOG_DATA);

  readonly units: Unit[] = ['minutes', 'hours', 'days'];

  value = signal<number>(90);
  unit = signal<Unit>('minutes');
  saving = signal(false);
  serverError = signal<string | null>(null);

  seconds = computed(() => Math.round(this.value() * UNIT_SECONDS[this.unit()]));

  /** The floor the platform imposes, in seconds — 0 when there is none. */
  private floor = computed(
    () => this.data.buckets.find((b) => b.code === this.data.minBucket)?.seconds ?? 0,
  );

  /** Divisors of a day near this size, so a refusal can suggest what would work. */
  private nearest = computed<[number | null, number | null]>(() => {
    const s = this.seconds();
    const divisors: number[] = [];
    for (let n = 60; n <= 86_400; n++) if (86_400 % n === 0) divisors.push(n);
    const below = [...divisors].reverse().find((n) => n < s) ?? null;
    const above = divisors.find((n) => n > s) ?? null;
    return [below, above];
  });

  private fmt(seconds: number): string {
    if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    return `${seconds / 60}m`;
  }

  /**
   * The one refusal that applies, in the words of the rule that fired.
   *
   * Order matters: "below the minimum" is more actionable than "does not divide a day" for a size
   * that fails both, because the person cannot fix the second while the first still holds.
   */
  /** What this kind is called in a refusal, so the message reads as a sentence. */
  private kindLabel(): string {
    return this.data.kind === 'command' ? 'Commands' : 'Device events';
  }

  problem = computed<string | null>(() => {
    const s = this.seconds();
    if (!Number.isFinite(s) || s <= 0) return 'Enter a duration.';
    if (!Number.isInteger(s)) return 'A bucket has to be a whole number of seconds.';
    if (s < 60) return 'Below a minute a bucket holds fewer readings than it costs to store.';
    if (this.floor() > 0 && s < this.floor())
      return `This platform does not allow anything finer than ${this.fmt(this.floor())}.`;
    // Commands and device events roll up into DATE-keyed tables, so a sub-day bucket has nowhere
    // to be stored. Checked here rather than left to the server so the refusal arrives while the
    // number is still on screen, and before a size nobody can place enters the shared catalog.
    if (this.data.kind !== 'scalar' && s % 86_400 !== 0)
      return `${this.kindLabel()} are summarised by day, so a bucket here has to be a whole number of days.`;
    if (s % 86_400 !== 0 && 86_400 % s !== 0) {
      const [below, above] = this.nearest();
      const options = [below, above].filter((n): n is number => n !== null).map((n) => this.fmt(n));
      return `${this.value()} ${this.unit()} does not divide a day evenly, so its boundaries would drift against the clock${options.length ? ` — try ${options.join(' or ')}` : ''}.`;
    }
    return null;
  });

  /** An existing size is not an error — it just resolves to the row that already exists. */
  existing = computed<BucketView | undefined>(() =>
    this.data.buckets.find((b) => b.seconds === this.seconds()),
  );

  /** The boundaries this size produces, which is what makes the division rule self-evident. */
  preview = computed(() => (this.problem() ? '' : boundaryPreview(this.seconds())));

  rowsPerDay = computed(() => {
    const s = this.seconds();
    if (this.problem() || s <= 0) return null;
    const n = 86_400 / s;
    return Math.round(n * 100) / 100;
  });

  save(): void {
    if (this.problem() || this.saving()) return;
    this.saving.set(true);
    this.serverError.set(null);
    this.api.createBucket(this.seconds()).subscribe({
      next: (b) => this.ref.close(b),
      error: (e: { error?: { error?: string } }) => {
        this.saving.set(false);
        this.serverError.set(e.error?.error ?? 'Could not add that size.');
      },
    });
  }

  cancel(): void {
    this.ref.close();
  }
}
