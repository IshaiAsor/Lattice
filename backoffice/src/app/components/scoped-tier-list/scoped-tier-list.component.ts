import {
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { TierEditorComponent } from '../tier-editor/tier-editor.component';
import {
  tierSummary,
  type BucketView,
  type TierView,
} from '../../services/retention-tiers.service';
import type { DataKind, UsageBucket } from '../../services/retention.service';

// One tier list at one scope (F18.20): "Follows X · Customise", or the editor with Save / Discard /
// "Remove list — follow X". The device page, a sensor row, a setup's action row and a blueprint slot
// action all have exactly this shape, so it is written once.
//
// The host does the HTTP: this emits `save` and `clear`, and the host passes the new `own` back in.
// A changed `own` is taken as "the server answered", which drops the local draft AND resets the
// editor's own — the Discard bug F18.21 found (Settings hid Save but left the edited values on
// screen) cannot happen on any screen built on this.

@Component({
  selector: 'app-scoped-tier-list',
  standalone: true,
  imports: [CommonModule, MatIconModule, TierEditorComponent],
  templateUrl: './scoped-tier-list.component.html',
  styleUrls: ['./scoped-tier-list.component.css'],
})
export class ScopedTierListComponent {
  /** The list stored at this scope — empty when it follows a wider one. */
  own = input.required<TierView[]>();
  /** What applies without this scope's list, as the object of "follows" ("this device"). */
  fallbackLabel = input.required<string>();
  /** That fallback's list — shown in one line, and where Customise starts from. */
  fallbackTiers = input.required<TierView[]>();
  kind = input.required<DataKind>();
  buckets = input.required<BucketView[]>();
  minBucket = input<string>('raw');
  ceilings = input<Record<string, number | null>>({});
  usage = input<Record<string, UsageBucket>>({});
  showStored = input<boolean>(false);
  /** Who the buttons are about — "Save for Tank level". Empty keeps them generic. */
  subject = input<string>('');
  /** A request is in flight; every control waits for it. */
  busy = input<boolean>(false);

  save = output<TierView[]>();
  clear = output<void>();

  private editor = viewChild(TierEditorComponent);

  /** The unsaved edit, if any. */
  draft = signal<TierView[] | null>(null);

  dirty = computed(() => this.draft() !== null);
  editing = computed(() => this.own().length > 0 || this.dirty());
  shown = computed(() => this.draft() ?? this.own());
  fallbackSummary = computed(() => tierSummary(this.fallbackTiers(), this.buckets()));

  /** The stored list as last seen, and the list last submitted — compared by content, not identity. */
  private lastOwn: string | null = null;
  private pending: string | null = null;

  constructor() {
    // A changed `own` is the server's answer to a save or a clear, so whatever was being edited is
    // settled. By CONTENT: a host reloads its whole view after any row saves, which hands every row a
    // new array — settling on identity would wipe an unsaved edit in a different row. Matching the
    // list just submitted also settles, so saving an unchanged list does not leave Save showing.
    effect(() => {
      const key = keyOf(this.own());
      untracked(() => {
        if (key === this.lastOwn && key !== this.pending) return;
        this.lastOwn = key;
        this.pending = null;
        this.settle();
      });
    });
  }

  /** Start this scope's own list from the one it was already following. */
  customise(): void {
    const from = this.fallbackTiers();
    this.draft.set(
      from.length === 0
        ? [{ bucket: 'raw', keepDays: 0, position: 0 }]
        : [...from]
            .sort((a, b) => a.position - b.position)
            .map((t, i) => ({ bucket: t.bucket, keepDays: t.keepDays, position: i })),
    );
  }

  onChanged(tiers: TierView[]): void {
    this.draft.set(tiers);
  }

  discard(): void {
    this.settle();
  }

  submit(): void {
    const tiers = this.draft();
    if (!tiers) return;
    this.pending = keyOf(tiers);
    this.save.emit(tiers);
  }

  remove(): void {
    this.clear.emit();
  }

  private settle(): void {
    this.draft.set(null);
    this.editor()?.reset();
  }
}

/** A list's content, in stored order, for comparing two lists regardless of array identity. */
function keyOf(tiers: readonly TierView[]): string {
  return JSON.stringify(
    [...tiers].sort((a, b) => a.position - b.position).map((t) => [t.bucket, t.keepDays]),
  );
}
