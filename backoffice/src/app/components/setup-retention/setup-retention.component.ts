import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, type Observable } from 'rxjs';
import {
  RetentionTiersService,
  followsPhrase,
  tierSummary,
  type ActionRetentionView,
  type BucketView,
  type MyTiersView,
  type SetupRetentionView,
  type TierScope,
  type TierView,
} from '../../services/retention-tiers.service';
import type { DataKind } from '../../services/retention.service';
import { ScopedTierListComponent } from '../scoped-tier-list/scoped-tier-list.component';
import { ScopeChipComponent } from '../scope-chip/scope-chip.component';

// A setup's Data tab (F18.20): how long each action in the setup keeps its readings, who decided —
// the blueprint, its sealed template, the owner's settings — and the owner's own list where they keep
// one. The owner's list is stored on the device's ACTION (there is no setup scope), so it belongs to
// the device and stays if the device leaves the setup; the editor says so.

@Component({
  selector: 'app-setup-retention',
  standalone: true,
  imports: [CommonModule, RouterModule, MatIconModule, ScopedTierListComponent, ScopeChipComponent],
  templateUrl: './setup-retention.component.html',
  styleUrls: ['./setup-retention.component.css'],
})
export class SetupRetentionComponent {
  instanceId = input.required<number>();

  private api = inject(RetentionTiersService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  view = signal<SetupRetentionView | null>(null);
  buckets = signal<BucketView[]>([]);
  /** The owner's knobs per kind — the platform minimum and ceilings their lists are held to. */
  knobs = signal<MyTiersView[]>([]);
  open = signal<Record<number, boolean>>({});
  busy = signal(false);

  private actions = computed(() =>
    (this.view()?.slots ?? []).flatMap((s) => s.devices.flatMap((d) => d.actions)),
  );
  total = computed(() => this.actions().length);
  /** Actions the blueprint has a list for — deciding, or held under the owner's own. */
  byBlueprint = computed(
    () =>
      this.actions().filter((a) =>
        a.scopes.some(
          (s) => s.scope === 'blueprint' && (s.state === 'answering' || s.state === 'has-list'),
        ),
      ).length,
  );
  ownCount = computed(() => this.actions().filter((a) => a.own.length > 0).length);

  constructor() {
    effect(() => this.load(this.instanceId()));
  }

  private load(instanceId: number): void {
    forkJoin({
      view: this.api.setupRetention(instanceId),
      buckets: this.api.buckets(),
      knobs: this.api.mine(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ view, buckets, knobs }) => {
          this.view.set(view);
          this.buckets.set(buckets);
          this.knobs.set(knobs);
        },
        error: () =>
          this.snack.open('Could not load what this setup keeps', 'Dismiss', { duration: 4000 }),
      });
  }

  toggle(actionId: number): void {
    this.open.update((o) => ({ ...o, [actionId]: !o[actionId] }));
  }

  summary(tiers: readonly TierView[]): string {
    return tierSummary(tiers, this.buckets());
  }

  /** "Decided by", in the owner's words: their own list is "Your list", the blueprint is this one. */
  decidedBy(a: ActionRetentionView): { scope: TierScope; text: string } {
    const s = a.effective.source;
    switch (s) {
      case 'action':
        return { scope: s, text: 'Your list' };
      case 'device':
        return { scope: s, text: 'Your device list' };
      case 'blueprint':
        return { scope: s, text: 'This blueprint' };
      case 'sealed':
        return {
          scope: s,
          text: a.effective.sourceLabel ? `Sealed template · ${a.effective.sourceLabel}` : 'Sealed template',
        };
      case 'user':
        return { scope: s, text: 'Your settings' };
      case 'platform':
        return { scope: s, text: 'Platform' };
    }
  }

  /** Whether the blueprint sets nothing for this action — worth saying under a plain summary. */
  blueprintSilent(a: ActionRetentionView): boolean {
    return a.scopes.some((s) => s.scope === 'blueprint' && s.state === 'empty');
  }

  fallbackLabel(a: ActionRetentionView): string {
    return a.fallback.source === 'blueprint' ? 'this blueprint' : followsPhrase(a.fallback.source);
  }

  minBucket(kind: DataKind): string {
    return this.knobs().find((k) => k.dataKind === kind)?.minBucket ?? 'raw';
  }

  ceilings(kind: DataKind): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const t of this.knobs().find((k) => k.dataKind === kind)?.platformTiers ?? [])
      out[t.bucket] = t.maxKeepDays;
    return out;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  save(a: ActionRetentionView, tiers: TierView[]): void {
    const previous = a.own;
    this.write(this.api.setActionTiers(a.actionId, a.dataKind, tiers), `Saved for ${a.name}`, () =>
      this.restore(a, previous),
    );
  }

  clear(a: ActionRetentionView): void {
    const previous = a.own;
    this.write(
      this.api.clearActionTiers(a.actionId, a.dataKind),
      `${a.name} now follows ${this.fallbackLabel(a)}`,
      () => this.restore(a, previous),
    );
  }

  /** Drop every list the owner keeps on this setup's actions, so each follows the blueprint again. */
  useBlueprintEverywhere(): void {
    const own = this.actions().filter((a) => a.own.length > 0);
    if (own.length === 0) return;
    const before = own.map((a) => ({ a, tiers: a.own }));
    this.write(
      forkJoin(own.map((a) => this.api.clearActionTiers(a.actionId, a.dataKind))),
      `${own.length} list(s) removed — this setup follows the blueprint again`,
      () =>
        this.write(
          forkJoin(before.map(({ a, tiers }) => this.api.setActionTiers(a.actionId, a.dataKind, tiers))),
          'Restored',
        ),
    );
  }

  private restore(a: ActionRetentionView, previous: TierView[]): void {
    this.write(
      previous.length > 0
        ? this.api.setActionTiers(a.actionId, a.dataKind, previous)
        : this.api.clearActionTiers(a.actionId, a.dataKind),
      'Restored',
    );
  }

  /** One write, then one reload; the notice offers Undo when there is something to go back to. */
  private write(request: Observable<unknown>, done: string, undo?: () => void): void {
    this.busy.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(this.instanceId());
        const ref = this.snack.open(done, undo ? 'Undo' : undefined, { duration: 6000 });
        if (undo) ref.onAction().subscribe(() => undo());
      },
      error: (e: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.snack.open(e.error?.error ?? 'Could not save retention', 'Dismiss', { duration: 6000 });
      },
    });
  }
}
