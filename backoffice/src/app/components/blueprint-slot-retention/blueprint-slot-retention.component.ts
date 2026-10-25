import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  RetentionTiersService,
  tierSummary,
  type BlueprintRetentionView,
  type BucketView,
  type PolicyTiersView,
  type TierScope,
  type TierView,
} from '../../services/retention-tiers.service';
import type { DataKind } from '../../services/retention.service';
import { ScopedTierListComponent } from '../scoped-tier-list/scoped-tier-list.component';
import { ScopeChipComponent } from '../scope-chip/scope-chip.component';

// A blueprint slot's actions, and how long each keeps its readings (F18.20).
//
// A list is set on the SAVED slot: the API refuses a slot or action the stored blueprint does not
// have, and a blueprint save drops the lists of slots it removes. So a slot that is new, or whose
// template the draft has changed, shows its actions but asks for a save before retention.
//
// Lists are live, not drafted — they apply at once to every setup of the blueprint, as sealed lists
// do. The strip above the rows says so.

type SlotView = BlueprintRetentionView['slots'][number];
type ActionView = SlotView['actions'][number];

@Component({
  selector: 'app-blueprint-slot-retention',
  standalone: true,
  imports: [CommonModule, MatIconModule, ScopedTierListComponent, ScopeChipComponent],
  templateUrl: './blueprint-slot-retention.component.html',
  styleUrls: ['./blueprint-slot-retention.component.css'],
})
export class BlueprintSlotRetentionComponent {
  blueprintId = input<number | null>(null);
  slotKey = input.required<string>();
  /** The template the DRAFT has chosen — compared against the saved slot's. */
  templateName = input.required<string>();
  /** The draft template's actions, shown as a plain list when the slot cannot be edited yet. */
  draftActions = input.required<{ name: string; label: string }[]>();
  view = input<BlueprintRetentionView | null>(null);
  buckets = input<BucketView[]>([]);
  policies = input<PolicyTiersView[]>([]);

  updated = output<BlueprintRetentionView>();

  private api = inject(RetentionTiersService);
  private snack = inject(MatSnackBar);

  open = signal<Record<string, boolean>>({});
  busy = signal(false);

  /** The saved slot, when it is the slot the draft shows — same key AND same template. */
  saved = computed<SlotView | null>(() => {
    const v = this.view();
    if (!v || this.blueprintId() === null) return null;
    return (
      v.slots.find((s) => s.slotKey === this.slotKey() && s.templateName === this.templateName()) ??
      null
    );
  });

  instanceCount = computed(() => this.view()?.instanceCount ?? 0);

  toggle(name: string): void {
    this.open.update((o) => ({ ...o, [name]: !o[name] }));
  }

  private policy(kind: DataKind): PolicyTiersView | undefined {
    return this.policies().find((p) => p.dataKind === kind);
  }

  minBucket(kind: DataKind): string {
    return this.policy(kind)?.minBucket ?? 'raw';
  }

  ceilings(kind: DataKind): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const t of this.policy(kind)?.tiers ?? []) out[t.bucket] = t.maxKeepDays;
    return out;
  }

  /**
   * Who decides for a device bound here, from the blueprint's side: its own list, else the sealed
   * template's, else each owner's settings — which the author cannot know, so the platform default
   * stands in for it.
   */
  decider(a: ActionView): { scope: TierScope; text: string } {
    if (a.own.length > 0) return { scope: 'blueprint', text: 'This blueprint' };
    if (a.sealed.length > 0) return { scope: 'sealed', text: 'Sealed template' };
    return { scope: 'user', text: "Owner's settings" };
  }

  keptText(a: ActionView): string {
    if (a.own.length > 0) return tierSummary(a.own, this.buckets());
    if (a.sealed.length > 0) return tierSummary(a.sealed, this.buckets());
    return `Platform default: ${tierSummary(this.policy(a.dataKind)?.tiers ?? [], this.buckets())}`;
  }

  fallbackLabel(a: ActionView): string {
    return a.sealed.length > 0 ? 'the sealed template' : "each owner's settings";
  }

  /** What removing the blueprint's list falls back to — and where Customise starts from. */
  fallbackTiers(a: ActionView): TierView[] {
    return a.sealed.length > 0 ? a.sealed : (this.policy(a.dataKind)?.tiers ?? []);
  }

  save(a: ActionView, tiers: TierView[]): void {
    const id = this.blueprintId();
    if (id === null) return;
    this.busy.set(true);
    this.api.setBlueprintTiers(id, this.slotKey(), a.actionName, a.dataKind, tiers).subscribe({
      next: (view) => {
        this.busy.set(false);
        this.updated.emit(view);
        this.snack.open(
          this.instanceCount() > 0
            ? `Saved — applies now to ${a.label} in ${this.instanceCount()} setup(s)`
            : 'Saved',
          undefined,
          { duration: 3000 },
        );
      },
      error: (e: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.snack.open(e.error?.error ?? 'Could not save retention', 'Dismiss', { duration: 6000 });
      },
    });
  }

  clear(a: ActionView): void {
    const id = this.blueprintId();
    if (id === null) return;
    this.busy.set(true);
    this.api.clearBlueprintTiers(id, this.slotKey(), a.actionName, a.dataKind).subscribe({
      next: (view) => {
        this.busy.set(false);
        this.updated.emit(view);
        this.snack.open(`${a.label} now follows ${this.fallbackLabel(a)}`, undefined, {
          duration: 3000,
        });
      },
      error: (e: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.snack.open(e.error?.error ?? 'Could not remove retention', 'Dismiss', {
          duration: 6000,
        });
      },
    });
  }
}
