import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin, Observable } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  BindingView,
  BlueprintsService,
  DerivePreview,
  InstanceSummary,
  InstanceView,
  SlotCandidate,
  SlotMatch,
} from 'src/app/services/blueprints.service';
import { BlueprintDeriveDialogComponent } from '../blueprint-derive-dialog/blueprint-derive-dialog.component';
import { SetupLifecycleService } from '../blueprint-instance/setup-lifecycle.service';
import { BindingLifecycleService } from '../blueprint-instance/binding-lifecycle.service';
import { currentPhaseTimerLabel, formatDuration } from '../blueprint-instance/phase-timer.util';
import {
  currentPhase,
  leadTrack,
  overallPercent,
  phaseFillPercent,
  phaseWeight,
  positionLabel,
} from 'src/app/utils/phase-track.util';
import { DeviceTrack, PhaseTrackItem } from 'src/app/services/blueprints.service';

/**
 * One lifecycle inside a setup card — the setup's own, or one bound device's (F11.4).
 *
 * Built once per load rather than derived in the template: the shape does not change between
 * ticks, only the numbers do, and rebuilding a row array on every change detection is how a list
 * of five setups starts dropping frames.
 */
interface TrackRow {
  key: string;
  label: string;
  /** Null for the setup's own lifecycle — there is no device to act on. */
  bindingId: number | null;
  phases: PhaseTrackItem[];
  phaseName: string | null;
  durationSeconds: number | null;
  elapsedSeconds: number;
  /** What any gate reads: running only while this owner *and* its setup are. */
  state: string;
  /** This owner's own state, which is what its button acts on. */
  ownState: string;
}

/** Devices past this many get a "+n more" line: a panel must not become a page. */
const MAX_DEVICE_ROWS = 4;

// The blueprints page (F10.8): what you can set up, and what you already have set up.
//
// The gallery deliberately shows readiness *before* the user commits to anything — a blueprint
// needing a device you don't own is the common case, and finding that out three steps into a
// wizard is the frustrating way to learn it.
//
// "Your setups" carries the lifecycle (F10.13) rather than just names: a list of setups that all
// look alike cannot tell a running one from a parked one, and "is this actually doing anything?"
// is the question a user opens this page with.
//
// Each setup is a small panel (F11.4): a header with the setup's state, its actions and a ring for
// how far through the whole lifecycle it is, then one row per lifecycle beneath — the setup's own,
// or one per bound device that carries its own. The rows exist because "3 devices · 1 running" is
// an answer the user then has to go and decode: which one is running, where is each, and how long
// until something happens. Per-device pause lives on the row for the same reason — it was the most
// common reason to open the detail page.
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
  private bindingLifecycle = inject(BindingLifecycleService);

  available: DerivePreview[] = [];
  setups: InstanceSummary[] = [];
  loading = true;
  /** Id of the setup whose lifecycle action is in flight — disables that row only. */
  busyId: number | null = null;

  /** Body rows per setup, rebuilt on load. Structure is stable between ticks; only numbers move. */
  private rows = new Map<number, TrackRow[]>();

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
        this.rows = new Map(setups.map((s) => [s.id, this.buildRows(s)]));
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

  /** Reset discards banked time, so it needs time to have been banked somewhere. */
  canReset(s: InstanceSummary): boolean {
    if (s.lifecycle_state === 'not_started') return false;
    return s.has_phases || s.device_tracks.length > 0;
  }

  /** Elapsed in the current phase, ticked forward locally rather than re-fetched. */
  elapsedSeconds(s: InstanceSummary): number {
    return s.elapsed_seconds + (this.isRunning(s) ? this.tickOffset : 0);
  }

  // ── The panel body (F11.4) ───────────────────────────────────────────
  //
  // One row per lifecycle: the setup's own, or one per bound device that carries one. A setup with
  // neither — a static blueprint — has no body at all and stays the single row it always was.

  private buildRows(s: InstanceSummary): TrackRow[] {
    if (s.device_tracks.length > 0) {
      return s.device_tracks.slice(0, MAX_DEVICE_ROWS).map((d) => this.deviceRow(d));
    }
    if (s.phases.length === 0) return [];
    return [
      {
        key: `setup-${s.id}`,
        label: 'Whole setup',
        bindingId: null,
        phases: s.phases,
        phaseName: s.current_phase?.name ?? null,
        durationSeconds: s.duration_seconds,
        elapsedSeconds: s.elapsed_seconds,
        state: s.lifecycle_state,
        ownState: s.lifecycle_state,
      },
    ];
  }

  private deviceRow(d: DeviceTrack): TrackRow {
    return {
      key: `binding-${d.binding_id}`,
      label: d.label,
      bindingId: d.binding_id,
      phases: d.phases,
      phaseName: d.current_phase?.name ?? null,
      durationSeconds: d.duration_seconds,
      elapsedSeconds: d.elapsed_seconds,
      state: d.effective_state,
      ownState: d.lifecycle_state,
    };
  }

  rowsFor(s: InstanceSummary): TrackRow[] {
    return this.rows.get(s.id) ?? [];
  }

  hiddenDeviceCount(s: InstanceSummary): number {
    return Math.max(0, s.device_tracks.length - MAX_DEVICE_ROWS);
  }

  /**
   * The track the header's ring describes: the setup's own, else the device that will need you
   * first. The same rule the dashboard tile uses, so one setup cannot be summarised two ways.
   */
  headTrack(s: InstanceSummary): PhaseTrackItem[] {
    if (s.phases.length > 0) return s.phases;
    return leadTrack(s.device_tracks, this.tickOffset)?.phases ?? [];
  }

  overallPercent(s: InstanceSummary): number {
    return overallPercent(this.headTrack(s), this.tickOffset, this.isRunning(s));
  }

  positionLabel(s: InstanceSummary): string {
    return positionLabel(this.headTrack(s));
  }

  ringTooltip(s: InstanceSummary): string {
    const track = this.headTrack(s);
    const phase = currentPhase(track);
    const pct = Math.round(this.overallPercent(s));
    if (!phase) return `${track.length} phases — not started`;
    return `${phase.name} — ${pct}% through the whole lifecycle`;
  }

  // ── One row's track ──────────────────────────────────────────────────

  private tickFor(row: TrackRow): number {
    return row.state === 'running' ? this.tickOffset : 0;
  }

  weightOf(row: TrackRow, phase: PhaseTrackItem): number {
    return phaseWeight(phase, row.phases);
  }

  fillOf(row: TrackRow, phase: PhaseTrackItem): number {
    return phaseFillPercent(phase, row.phases, this.tickFor(row), row.state === 'running');
  }

  railLabel(row: TrackRow): string {
    const index = row.phases.findIndex((p) => p.is_current);
    if (index === -1) return `${row.label}: not started, ${row.phases.length} phases`;
    return `${row.label}: phase ${index + 1} of ${row.phases.length}, ${row.phases[index]!.name}`;
  }

  /** The lengths behind the bar, so a segment nobody can hit is still readable. */
  railTooltip(row: TrackRow): string {
    return row.phases
      .map(
        (p) =>
          `${p.name} · ${p.duration_seconds ? formatDuration(p.duration_seconds) : 'no limit'}`,
      )
      .join('\n');
  }

  /** "1d 4h left", or what a parked clock honestly reads. */
  timerOf(row: TrackRow): string {
    if (row.ownState === 'not_started') return 'not started';
    if (!row.phaseName) return 'no phase yet';
    return currentPhaseTimerLabel(
      row.elapsedSeconds + this.tickFor(row),
      row.durationSeconds,
      row.state === 'running',
    );
  }

  /** "Commissioning · 1d left", or — with no lifecycle to describe — where the setup came from. */
  phaseLine(s: InstanceSummary): string {
    // A setup whose bound devices each run their own schedule has no single phase to name, so the
    // row says how many of them are actually running instead (F11.4) — the honest summary when the
    // answer is not one thing.
    if (s.devices.total > 0) {
      const suffix = s.lifecycle_state === 'running' ? '' : ' · setup paused';
      return `${s.devices.total} device${s.devices.total === 1 ? '' : 's'} · ${s.devices.running} running${suffix}`;
    }
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

  // ── Per-device lifecycle (F11.4) ─────────────────────────────────────
  //
  // Both go through BindingLifecycleService, so pausing one device from here asks the same question
  // in the same words as pausing it from the detail page.

  /**
   * Starting asks which phase and how far into it, which needs the device's whole track in the
   * shape the dialog takes — so the bindings are fetched on the click rather than carried by every
   * list render. The same trade SetupLifecycleService.start already makes.
   */
  startDevice(s: InstanceSummary, row: TrackRow, event: Event): void {
    event.stopPropagation();
    if (this.busyId !== null || row.bindingId === null) return;
    const bindingId = row.bindingId;
    this.busyId = s.id;
    this.blueprints.listBindings(s.id).subscribe({
      next: (bindings) => {
        const binding = bindings.find((b) => b.binding_id === bindingId);
        this.busyId = null;
        if (!binding) {
          this.snackBar.open('That device is no longer part of this setup', 'Close', {
            duration: 3500,
          });
          this.load();
          return;
        }
        this.actOnDevice(
          s,
          this.bindingLifecycle.start(binding),
          `Started: ${row.label}`,
          'Could not start this device',
        );
      },
      error: () => {
        this.busyId = null;
        this.snackBar.open('Could not read this setup’s devices', 'Close', { duration: 3500 });
      },
    });
  }

  stopDevice(s: InstanceSummary, row: TrackRow, event: Event): void {
    event.stopPropagation();
    if (this.busyId !== null || row.bindingId === null) return;
    this.actOnDevice(
      s,
      this.bindingLifecycle.stop({ binding_id: row.bindingId, label: row.label }),
      `Paused: ${row.label}`,
      'Could not pause this device',
    );
  }

  /**
   * A device may be started while its setup is parked — the API allows it and the state is real —
   * but nothing it owns will act until the setup is continued, so the button says so up front.
   */
  deviceStartTooltip(s: InstanceSummary, row: TrackRow): string {
    const verb = row.ownState === 'stopped' ? 'Continue' : 'Start';
    if (!this.isRunning(s)) return `${verb} ${row.label} — held until the setup is continued`;
    return `${verb} ${row.label}`;
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

  /** The same, for an action that resolves to a binding rather than the setup. */
  private actOnDevice(
    setup: InstanceSummary,
    action: Observable<BindingView | null>,
    done: string,
    failed: string,
  ): void {
    this.busyId = setup.id;
    action.subscribe({
      next: (updated) => {
        this.busyId = null;
        if (!updated) return; // backed out of the confirm — not an error
        this.load();
        this.snackBar.open(done, 'Close', { duration: 2500 });
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

  /**
   * The row is a button, but it also holds the per-setup action buttons. Keyboard activation of an
   * action bubbles its keyup up to the row, so only open when the row itself was the focused
   * element — the mouse path is covered by each action stopping its own click.
   */
  openFromKey(setup: InstanceSummary, event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.open(setup);
  }
}
