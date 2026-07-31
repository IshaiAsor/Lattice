import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { ConfirmDialogComponent } from '../admin-device-config/confirm-dialog.component';
import {
  BlueprintsService,
  InstanceEntity,
  InstancePhase,
  InstanceView,
  ParamPhaseCell,
  ReconcileResult,
  ResolvedParam,
} from 'src/app/services/blueprints.service';

// One derived setup (F10.8): its devices, where it is in its lifecycle, what it is tuned to, and
// what has drifted from the blueprint.
//
// The parameter list is the interesting part. Each row shows the *resolved* value and where it
// came from — the blueprint's default, the current phase, or the user's own override — because
// "20" alone doesn't tell you whether editing the phase would change it. Setting a value writes an
// override row (never an edit to a rule), and clearing it hands the parameter back to the phase.
//
// Every override is scoped, and the two scopes are deliberately different acts:
//   - the collapsed row writes an **all-phases** value — "I want this, whatever the schedule says";
//   - expanding shows one row per phase, each writing that **phase alone**, so a user can tune a
//     phase they are not in yet and leave the rest of the lifecycle on the blueprint.
// Both write instance-scoped rows, so nothing here can affect another setup built from the same
// blueprint.
@Component({
  selector: 'app-blueprint-instance',
  imports: [SHARED_MATERIAL],
  templateUrl: './blueprint-instance.component.html',
  styleUrl: './blueprint-instance.component.css',
})
export class BlueprintInstanceComponent implements OnInit {
  private blueprints = inject(BlueprintsService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  instance?: InstanceView;
  loading = true;
  busy = false;
  /**
   * Draft values for the override inputs, keyed by param *and scope* (see `draftKey`) so the
   * all-phases box and each phase's box hold their own text. Committed on blur/Enter.
   */
  drafts: Record<string, string> = {};
  /** Params whose per-phase breakdown is open. Collapsed by default — most tuning is global. */
  expanded = new Set<string>();

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.load(id);
  }

  private load(id: number): void {
    this.loading = true;
    this.blueprints.getInstance(id).subscribe({
      next: (instance) => this.apply(instance),
      error: () => {
        this.loading = false;
        this.snackBar.open('Setup not found', 'Close', { duration: 3000 });
        void this.router.navigate(['/blueprints']);
      },
    });
  }

  private apply(instance: InstanceView): void {
    this.instance = instance;
    this.loading = false;
    this.busy = false;
    this.drafts = {};
    for (const p of instance.params) {
      this.drafts[this.draftKey(p, null)] = p.value ?? '';
      for (const cell of p.phases) this.drafts[this.draftKey(p, cell)] = cell.value ?? '';
    }
  }

  // ── Phases ───────────────────────────────────────────────────────────

  setPhase(phase: InstancePhase): void {
    if (!this.instance || phase.is_current || this.busy) return;
    this.busy = true;
    this.blueprints.setPhase(this.instance.id, phase.key).subscribe({
      next: (updated) => {
        this.apply(updated);
        this.snackBar.open(`Moved to ${phase.name}`, 'Close', { duration: 2500 });
      },
      error: () => {
        this.busy = false;
        this.snackBar.open('Could not change phase', 'Close', { duration: 3000 });
      },
    });
  }

  phaseDuration(phase: InstancePhase): string {
    if (!phase.duration_value || !phase.duration_unit) return '';
    const unit =
      phase.duration_value === 1 ? phase.duration_unit.replace(/s$/, '') : phase.duration_unit;
    return `${phase.duration_value} ${unit}${phase.auto_advance ? ', then advances' : ''}`;
  }

  // ── Parameters ───────────────────────────────────────────────────────

  /**
   * `null` cell = the all-phases scope; a cell = that phase alone.
   *
   * The space separator is safe because both key kinds are validated server-side to
   * `[A-Za-z0-9_.]` (see `validateParamKey`), so no composite key can collide with another.
   */
  draftKey(param: ResolvedParam, cell: ParamPhaseCell | null): string {
    return cell ? `${param.key} ${cell.phase_key}` : param.key;
  }

  sourceLabel(source: string): string {
    if (source === 'phase_override') return 'your value, this phase';
    if (source === 'override') return 'your value, every phase';
    if (source === 'phase') return 'from this phase';
    return 'blueprint default';
  }

  toggleExpanded(param: ResolvedParam): void {
    if (this.expanded.has(param.key)) this.expanded.delete(param.key);
    else this.expanded.add(param.key);
  }

  isExpanded(param: ResolvedParam): boolean {
    return this.expanded.has(param.key);
  }

  /** True when the user has pinned this param anywhere — what the expand affordance advertises. */
  tunedPhaseCount(param: ResolvedParam): number {
    return param.phases.filter((p) => p.phase_override !== null).length;
  }

  commitParam(param: ResolvedParam, cell: ParamPhaseCell | null = null): void {
    if (!this.instance || this.busy) return;
    const draft = (this.drafts[this.draftKey(param, cell)] ?? '').trim();
    // Unchanged, or retyping exactly what it already resolves to — nothing to pin.
    if (draft === ((cell ? cell.value : param.value) ?? '')) return;
    this.write(param.key, draft === '' ? null : draft, cell?.phase_key ?? null);
  }

  clearParam(param: ResolvedParam, cell: ParamPhaseCell | null = null): void {
    if (!this.instance || this.busy) return;
    this.write(param.key, null, cell?.phase_key ?? null);
  }

  /** A cell is only clearable when the user pinned *that* scope — not an inherited value. */
  isPinned(param: ResolvedParam, cell: ParamPhaseCell | null): boolean {
    return cell ? cell.phase_override !== null : param.override_value !== null;
  }

  private write(key: string, value: string | null, phaseKey: string | null): void {
    this.busy = true;
    this.blueprints.setParam(this.instance!.id, key, value, phaseKey).subscribe({
      next: (updated) => {
        this.apply(updated);
        const scope = phaseKey ? 'for this phase' : 'for every phase';
        this.snackBar.open(
          value === null ? 'Back to the blueprint' : `Saved ${scope}`,
          'Close',
          { duration: 2000 },
        );
      },
      error: (err) => {
        this.busy = false;
        this.snackBar.open(err?.error?.error ?? 'Could not save', 'Close', { duration: 3500 });
      },
    });
  }

  // ── Drift + reconcile ────────────────────────────────────────────────

  driftedEntities(): (InstanceEntity & { kind: 'scene' | 'rule' | 'pipeline' })[] {
    if (!this.instance) return [];
    const { scenes, rules, pipelines } = this.instance.entities;
    return [
      ...scenes.map((s) => ({ ...s, kind: 'scene' as const })),
      ...rules.map((r) => ({ ...r, kind: 'rule' as const })),
      ...pipelines.map((p) => ({ ...p, kind: 'pipeline' as const })),
    ].filter((e) => e.user_modified);
  }

  reconcile(): void {
    if (!this.instance || this.busy) return;
    this.busy = true;
    this.blueprints.reconcile(this.instance.id).subscribe({
      next: (result) => {
        this.summarise(result);
        this.load(this.instance!.id);
      },
      error: () => {
        this.busy = false;
        this.snackBar.open('Could not update from the blueprint', 'Close', { duration: 3000 });
      },
    });
  }

  reset(entity: InstanceEntity & { kind: 'scene' | 'rule' | 'pipeline' }): void {
    if (!this.instance || this.busy) return;
    this.busy = true;
    this.blueprints.resetEntity(this.instance.id, entity.kind, entity.id).subscribe({
      next: () => {
        this.snackBar.open(`"${entity.name}" restored from the blueprint`, 'Close', {
          duration: 3000,
        });
        this.load(this.instance!.id);
      },
      error: () => {
        this.busy = false;
        this.snackBar.open('Could not restore', 'Close', { duration: 3000 });
      },
    });
  }

  /**
   * Delete the setup. The server removes the automations the blueprint owns and detaches the ones
   * the user edited (see removeInstance in blueprints.derive.service), so the confirm counts the
   * two groups separately — "delete" and "keep" applying to different rows in the same list is
   * exactly the kind of thing a user should be told before, not after.
   */
  remove(): void {
    if (!this.instance || this.busy) return;
    const instance = this.instance;
    const { scenes, rules, pipelines } = instance.entities;
    const derived = [...scenes, ...rules, ...pipelines];
    const kept = derived.filter((e) => e.user_modified).length;
    const removed = derived.length - kept;

    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [`Delete "${instance.name}"?`];
    if (removed > 0) {
      parts.push(
        `Its ${plural(removed, 'automation', 'automations')} from the blueprint will go too.`,
      );
    }
    if (kept > 0) {
      parts.push(
        `The ${plural(kept, 'automation', 'automations')} you edited ${kept === 1 ? 'is' : 'are'} kept, on ${kept === 1 ? 'its' : 'their'} own from now on.`,
      );
    }
    parts.push('Your devices are kept. This cannot be undone.');

    this.dialog
      .open(ConfirmDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: { title: 'Delete setup', message: parts.join(' '), confirmLabel: 'Delete' },
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (!confirmed) return;
        this.busy = true;
        this.blueprints.removeInstance(instance.id).subscribe({
          next: () => {
            this.snackBar.open(`"${instance.name}" deleted`, 'Close', { duration: 3000 });
            void this.router.navigate(['/blueprints']);
          },
          error: () => {
            this.busy = false;
            this.snackBar.open('Could not delete this setup', 'Close', { duration: 3000 });
          },
        });
      });
  }

  private summarise(result: ReconcileResult): void {
    const applied = result.changes.filter((c) =>
      ['created', 'updated', 'disabled'].includes(c.action),
    ).length;
    const skipped = result.changes.filter((c) => c.action === 'skipped_user_modified').length;
    const message =
      applied === 0 && skipped === 0
        ? 'Already up to date'
        : `${applied} updated${skipped > 0 ? `, ${skipped} of your edits kept` : ''}`;
    this.snackBar.open(message, 'Close', { duration: 3500 });
  }

  back(): void {
    void this.router.navigate(['/blueprints']);
  }
}
