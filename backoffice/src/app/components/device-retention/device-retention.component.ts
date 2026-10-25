import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, type Observable } from 'rxjs';
import {
  RetentionTiersService,
  followsPhrase,
  ladderName,
  tierSummary,
  type ActionRetentionView,
  type BucketView,
  type DeviceRetentionView,
  type KindKnobsView,
  type TierView,
} from '../../services/retention-tiers.service';
import type { DataKind } from '../../services/retention.service';
import { ScopedTierListComponent } from '../scoped-tier-list/scoped-tier-list.component';
import { ScopeLadderComponent } from '../scope-ladder/scope-ladder.component';
import { ScopeChipComponent } from '../scope-chip/scope-chip.component';

// The device page's Data tab (F18.20): how long this device's history is kept, per kind for the
// device as a whole and per sensor. Retention is the owner's even on a sealed board — the template
// fixes pins and actions, not how long their readings are kept.
//
// Every write reloads the whole view: a device list changes what every sensor without its own list
// shows, and a sensor list changes only its own row — both are exactly what one read answers.

const KIND_META: Record<string, { label: string; icon: string }> = {
  scalar: { label: 'Readings', icon: 'show_chart' },
  frame: { label: 'Camera frames', icon: 'photo_camera' },
};

@Component({
  selector: 'app-device-retention',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatIconModule,
    ScopedTierListComponent,
    ScopeLadderComponent,
    ScopeChipComponent,
  ],
  templateUrl: './device-retention.component.html',
  styleUrls: ['./device-retention.component.css'],
})
export class DeviceRetentionComponent {
  deviceId = input.required<number>();
  /** A sensor to open on arrival — the dashboard sheet's deep link. */
  focusActionId = input<number | null>(null);

  private api = inject(RetentionTiersService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);
  private injector = inject(Injector);

  view = signal<DeviceRetentionView | null>(null);
  buckets = signal<BucketView[]>([]);
  open = signal<Record<number, boolean>>({});
  busy = signal(false);
  loading = signal(false);

  readonly kindMeta = KIND_META;
  readonly ladderName = ladderName;
  readonly followsPhrase = followsPhrase;

  constructor() {
    effect(() => {
      const id = this.deviceId();
      const focus = this.focusActionId();
      this.open.set(focus ? { [focus]: true } : {});
      this.load(id, focus);
    });
  }

  private load(deviceId: number, focus: number | null = null): void {
    this.loading.set(true);
    forkJoin({ view: this.api.deviceRetention(deviceId), buckets: this.api.buckets() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ view, buckets }) => {
          this.view.set(view);
          this.buckets.set(buckets);
          this.loading.set(false);
          // After the rows are in the DOM, not on a timer guessing when that will be.
          if (focus)
            afterNextRender(
              () =>
                document
                  .getElementById(`ret-action-${focus}`)
                  ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
              { injector: this.injector },
            );
        },
        error: () => {
          this.loading.set(false);
          this.snack.open('Could not load retention for this device', 'Dismiss', {
            duration: 4000,
          });
        },
      });
  }

  toggle(actionId: number): void {
    this.open.update((o) => ({ ...o, [actionId]: !o[actionId] }));
  }

  knobs(kind: DataKind): KindKnobsView | undefined {
    return this.view()?.kinds.find((k) => k.dataKind === kind);
  }

  summary(tiers: readonly TierView[]): string {
    return tierSummary(tiers, this.buckets());
  }

  /** "Decided by" on a sensor row: the scope, and the named thing behind it where there is one. */
  decidedBy(a: ActionRetentionView): string {
    const s = a.effective.source;
    if ((s === 'blueprint' || s === 'sealed') && a.effective.sourceLabel)
      return `${ladderName(s)} · ${a.effective.sourceLabel}`;
    return ladderName(s);
  }

  /** A sensor without its own list falls back to this — named, for "Follows the blueprint …". */
  fallbackLabel(a: ActionRetentionView): string {
    return followsPhrase(a.fallback.source);
  }

  /** Whether any sensor here takes a blueprint or sealed list, which a device list would override. */
  hasBoardLists(kind: DataKind): boolean {
    return (this.view()?.actions ?? []).some(
      (a) =>
        a.dataKind === kind &&
        a.scopes.some(
          (s) =>
            (s.scope === 'blueprint' || s.scope === 'sealed') &&
            s.state !== 'empty' &&
            s.state !== 'n/a',
        ),
    );
  }

  sensorsOf(kind: DataKind): ActionRetentionView[] {
    return (this.view()?.actions ?? []).filter((a) => a.dataKind === kind);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  saveDevice(kind: DataKind, tiers: TierView[]): void {
    const previous = this.knobs(kind)?.own ?? [];
    this.write(this.api.setDeviceTiers(this.deviceId(), kind, tiers), 'Saved for this device', () =>
      this.restoreDevice(kind, previous),
    );
  }

  clearDevice(kind: DataKind): void {
    const previous = this.knobs(kind)?.own ?? [];
    this.write(
      this.api.clearDeviceTiers(this.deviceId(), kind),
      'Device list removed — sensors follow their own chain again',
      () => this.restoreDevice(kind, previous),
    );
  }

  saveAction(a: ActionRetentionView, tiers: TierView[]): void {
    const previous = a.own;
    this.write(this.api.setActionTiers(a.actionId, a.dataKind, tiers), `Saved for ${a.name}`, () =>
      this.restoreAction(a, previous),
    );
  }

  clearAction(a: ActionRetentionView): void {
    const previous = a.own;
    this.write(
      this.api.clearActionTiers(a.actionId, a.dataKind),
      `${a.name} now follows ${this.fallbackLabel(a)}`,
      () => this.restoreAction(a, previous),
    );
  }

  private restoreDevice(kind: DataKind, previous: TierView[]): void {
    this.write(
      previous.length > 0
        ? this.api.setDeviceTiers(this.deviceId(), kind, previous)
        : this.api.clearDeviceTiers(this.deviceId(), kind),
      'Restored',
    );
  }

  private restoreAction(a: ActionRetentionView, previous: TierView[]): void {
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
        this.load(this.deviceId());
        const ref = this.snack.open(done, undo ? 'Undo' : undefined, { duration: 6000 });
        if (undo) ref.onAction().subscribe(() => undo());
      },
      // The refusal names the rule and what would work instead — the useful part.
      error: (e: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.snack.open(e.error?.error ?? 'Could not save retention', 'Dismiss', {
          duration: 6000,
        });
      },
    });
  }
}
