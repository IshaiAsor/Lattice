import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin, Observable } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  BlueprintsService,
  DerivePreview,
  InstanceSummary,
  InstanceView,
  SlotCandidate,
  SlotMatch,
} from 'src/app/services/blueprints.service';
import { BlueprintDeriveDialogComponent } from '../blueprint-derive-dialog/blueprint-derive-dialog.component';
import { SetupLifecycleService } from '../blueprint-instance/setup-lifecycle.service';
import { currentPhaseTimerLabel, progressPercent } from '../blueprint-instance/phase-timer.util';

// The blueprints page (F10.8): what you can set up, and what you already have set up.
//
// The gallery deliberately shows readiness *before* the user commits to anything — a blueprint
// needing a device you don't own is the common case, and finding that out three steps into a
// wizard is the frustrating way to learn it.
//
// "Your setups" carries the lifecycle (F10.13) rather than just names: a list of setups that all
// look alike cannot tell a running one from a parked one, and "is this actually doing anything?"
// is the question a user opens this page with. Each row shows the state, the phase, that phase's
// progress, and the three actions — so the common case never needs the detail page at all.
@Component({
  selector: 'app-blueprints',
  imports: [SHARED_MATERIAL],
  templateUrl: './blueprints.component.html',
  styleUrl: './blueprints.component.css',
})
export class BlueprintsComponent implements OnInit, OnDestroy {
  private blueprints = inject(BlueprintsService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private router = inject(Router);
  private lifecycle = inject(SetupLifecycleService);

  available: DerivePreview[] = [];
  setups: InstanceSummary[] = [];
  loading = true;
  /** Id of the setup whose lifecycle action is in flight — disables that row only. */
  busyId: number | null = null;

  /** Seconds since the response was rendered; only the running phases tick. */
  private tickOffset = 0;
  private loadedAt = Date.now();
  private ticker?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    // Same ten seconds as the instance page and the cron's own period, so a countdown here cannot
    // sit visibly at zero while the phase has in fact already advanced.
    this.ticker = setInterval(() => {
      this.tickOffset = Math.floor((Date.now() - this.loadedAt) / 1000);
    }, 10_000);
  }

  ngOnDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  load(): void {
    this.loading = true;
    forkJoin({
      available: this.blueprints.listDerivable(),
      setups: this.blueprints.listInstances(),
    }).subscribe({
      next: ({ available, setups }) => {
        this.available = available;
        this.setups = setups;
        this.loadedAt = Date.now();
        this.tickOffset = 0;
        this.loading = false;
      },
      error: () => (this.loading = false),
    });
  }

  // ── Setup lifecycle ──────────────────────────────────────────────────
  //
  // The row's own copy of what the instance page shows. Both go through SetupLifecycleService, so
  // the confirms and the Start dialog are the same act wherever it is reached from.

  isRunning(s: InstanceSummary): boolean {
    return s.lifecycle_state === 'running';
  }

  isStopped(s: InstanceSummary): boolean {
    return s.lifecycle_state === 'stopped';
  }

  stateLabel(s: InstanceSummary): string {
    if (this.isRunning(s)) return 'Running';
    return this.isStopped(s) ? 'Paused' : 'Not started';
  }

  /**
   * Plenty of blueprints are not time-dependent, and some declare no phases at all. Such a setup
   * is simply on — there is no schedule to be ahead of or behind — so the row drops the state chip
   * and the progress bar and says what it always said. A chip reading "Running" on something that
   * has no other state is noise dressed as information.
   *
   * It keeps Pause/Continue, though: holding a setup's automations is meaningful with or without
   * a lifecycle. Only the *paused* state is worth announcing, because that one is not the default.
   */
  showStateChip(s: InstanceSummary): boolean {
    return s.has_phases || this.isStopped(s);
  }

  stateIcon(s: InstanceSummary): string {
    if (this.isRunning(s)) return 'play_circle';
    return this.isStopped(s) ? 'pause_circle' : 'schedule';
  }

  /** Elapsed in the current phase, ticked forward locally rather than re-fetched. */
  elapsedSeconds(s: InstanceSummary): number {
    return s.elapsed_seconds + (this.isRunning(s) ? this.tickOffset : 0);
  }

  progress(s: InstanceSummary): number {
    return progressPercent(this.elapsedSeconds(s), s.duration_seconds);
  }

  showProgressBar(s: InstanceSummary): boolean {
    return s.current_phase !== null && s.duration_seconds !== null;
  }

  /** "Commissioning · 1d left", or — with no lifecycle to describe — where the setup came from. */
  phaseLine(s: InstanceSummary): string {
    if (!s.has_phases) return `from ${s.blueprint_key}`;
    if (!s.current_phase) return 'No phase yet — start it to choose one';
    const timer = currentPhaseTimerLabel(
      this.elapsedSeconds(s),
      s.duration_seconds,
      this.isRunning(s),
    );
    return `${s.current_phase.name} · ${timer}`;
  }

  start(s: InstanceSummary, event: Event): void {
    this.act(
      s,
      event,
      this.lifecycle.start(s.id, {
        defaultPhaseKey: s.current_phase?.key ?? null,
        resuming: this.isStopped(s),
      }),
      'Setup started',
      'Could not start this setup',
    );
  }

  stop(s: InstanceSummary, event: Event): void {
    this.act(s, event, this.lifecycle.stop(s.id), 'Paused', 'Could not pause this setup');
  }

  resetLifecycle(s: InstanceSummary, event: Event): void {
    this.act(s, event, this.lifecycle.reset(s.id), 'Lifecycle reset', 'Could not reset');
  }

  /**
   * Every action sits inside a row that is itself a button to open the setup, so each one has to
   * stop the click travelling — otherwise confirming a stop also navigates away from the list that
   * was about to show the result.
   */
  private act(
    setup: InstanceSummary,
    event: Event,
    action: Observable<InstanceView | null>,
    done: string,
    failed: string,
  ): void {
    event.stopPropagation();
    if (this.busyId !== null) return;
    this.busyId = setup.id;
    action.subscribe({
      next: (updated) => {
        this.busyId = null;
        if (!updated) return; // backed out of the confirm — not an error
        this.load();
        this.snackBar.open(`${done}: ${setup.name}`, 'Close', { duration: 2500 });
      },
      error: (err) => {
        this.busyId = null;
        this.snackBar.open(err?.error?.error ?? failed, 'Close', { duration: 3500 });
      },
    });
  }

  /**
   * Devices a slot can actually take. A device already bound to another setup is listed by the
   * preview but cannot be bound again, so every readiness count here reads free devices only —
   * otherwise a blueprint whose only board is busy would advertise itself as ready.
   */
  freeCandidates(slot: SlotMatch): SlotCandidate[] {
    return slot.candidates.filter((c) => c.free);
  }

  /** A blueprint is ready when every required slot has at least one free matching device. */
  isReady(bp: DerivePreview): boolean {
    return bp.unmet.length === 0;
  }

  /** Slots the user must choose for — several free candidates, so auto-bind can't decide. */
  ambiguousCount(bp: DerivePreview): number {
    return bp.slots.filter((s) => this.freeCandidates(s).length > 1).length;
  }

  readinessText(bp: DerivePreview): string {
    if (!this.isReady(bp)) {
      const names = bp.slots
        .filter((s) => s.required && this.freeCandidates(s).length === 0)
        .map((s) => s.label);
      return `Needs ${names.join(' and ')}`;
    }
    const ambiguous = this.ambiguousCount(bp);
    return ambiguous > 0
      ? `Ready — ${ambiguous} choice${ambiguous > 1 ? 's' : ''} to make`
      : 'Ready to set up';
  }

  derive(bp: DerivePreview): void {
    if (!this.isReady(bp)) return;
    this.dialog
      .open(BlueprintDeriveDialogComponent, {
        width: '560px',
        maxHeight: '90vh',
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: { preview: bp },
      })
      .afterClosed()
      .subscribe((result) => {
        if (!result) return;
        this.snackBar.open(`"${result.name}" is set up`, 'Close', { duration: 3000 });
        void this.router.navigate(['/blueprints', result.instance_id]);
      });
  }

  open(setup: InstanceSummary): void {
    void this.router.navigate(['/blueprints', setup.id]);
  }
}
