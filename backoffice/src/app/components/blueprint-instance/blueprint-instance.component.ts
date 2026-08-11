import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { ConfirmDialogComponent } from '../admin-device-config/confirm-dialog.component';
import { PhaseChangeDialogComponent, PhaseChangeResult } from './phase-change-dialog.component';
import { SetupLifecycleService } from './setup-lifecycle.service';
import {
  currentPhaseTimerLabel,
  formatDuration,
  progressPercent,
  remainingSeconds,
} from './phase-timer.util';
import {
  BindingView,
  BlueprintsService,
  InstanceEntity,
  InstancePhase,
  InstanceView,
  ParamPhaseCell,
  ReconcileResult,
  ResolvedParam,
} from 'src/app/services/blueprints.service';
import { BindingLifecycleService } from './binding-lifecycle.service';
import { AuthService } from 'src/app/services/auth.service';

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
//
// The phase track carries the timers (F10.12). Every phase shows where it stands — including one
// with no duration, where "how long have I been here" is still the question being asked — and the
// running phase's number is ticked locally rather than polled: the server sends `elapsed_seconds`
// plus the inputs behind it, and this component adds its own wall-clock delta since load, so a
// browser clock that disagrees with the server cannot skew the countdown.
@Component({
  selector: 'app-blueprint-instance',
  imports: [SHARED_MATERIAL, MatTabsModule],
  templateUrl: './blueprint-instance.component.html',
  styleUrl: './blueprint-instance.component.css',
})
export class BlueprintInstanceComponent implements OnInit, OnDestroy {
  private blueprints = inject(BlueprintsService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private auth = inject(AuthService);
  private lifecycle = inject(SetupLifecycleService);
  private bindingLifecycle = inject(BindingLifecycleService);

  instance?: InstanceView;
  /**
   * The bound devices that run a lifecycle of their own (F11.4). Empty for a setup whose slots are
   * all unprofiled, which is every pre-F11 blueprint — the section then does not render at all.
   */
  bindings: BindingView[] = [];
  /** Which device is mid-action, so only its own buttons are disabled while it works. */
  bindingBusy: number | null = null;
  loading = true;
  busy = false;

  /**
   * Which tab is showing. Devices first: it is what the page is opened for, and the only tab that
   * always has something in it once a setup has bound anything.
   */
  activeTab = 0;

  /**
   * Where the Blueprint tab sits. Every other tab is conditional, so its index is however many of
   * them rendered — computed rather than hardcoded, or the "newer version" label would jump to
   * Settings on a setup with no devices.
   */
  get blueprintTabIndex(): number {
    let index = 0;
    if (this.hasDeviceLifecycles || this.sharedBindings().length > 0) index++;
    if ((this.instance?.params.length ?? 0) > 0) index++;
    if ((this.instance?.phases.length ?? 0) > 0) index++;
    return index;
  }

  /** Seconds since the response was rendered — what the running timer is ticked forward by. */
  private tickOffset = 0;
  private loadedAt = Date.now();
  private ticker?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.load(id);
    // A phase runs for days; a second-by-second redraw would be churn for no information. Ten
    // seconds also matches the cron's own period, so the countdown cannot visibly sit at zero
    // while the phase has in fact already advanced.
    this.ticker = setInterval(() => {
      this.tickOffset = Math.floor((Date.now() - this.loadedAt) / 1000);
    }, 10_000);
  }

  ngOnDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
    // A stepper mid-debounce would otherwise fire its write after the card is gone.
    for (const timer of Object.values(this.stepTimers)) clearTimeout(timer);
    for (const timer of Object.values(this.paramStepTimers)) clearTimeout(timer);
  }

  private load(id: number): void {
    this.loading = true;
    this.blueprints.getInstance(id).subscribe({
      next: (instance) => {
        this.apply(instance);
        this.loadBindings(instance);
      },
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
    // Every response re-bases the tick, so the numbers on screen are the server's plus only the
    // time this page has been looking at them.
    this.loadedAt = Date.now();
    this.tickOffset = 0;
  }

  // ── Per-device lifecycles (F11.4) ────────────────────────────────────
  //
  // A setup can hold several devices that are each on their own schedule. Each gets the same three
  // controls the setup has, one level down, plus "reset" doubling as re-profile — because a device
  // whose process has ended is exactly when swapping its schedule is safe.
  //
  // Fetched separately from the instance rather than nested inside it: the setup page is opened far
  // more often than it is acted on, and only a setup that actually has profiled slots pays for it.

  private loadBindings(instance: InstanceView): void {
    if (!instance.bindings.some((b) => b.binding_id !== null)) {
      this.bindings = [];
      return;
    }
    this.blueprints.listBindings(instance.id).subscribe({
      next: (bindings) => (this.bindings = bindings),
      // Non-fatal: the rest of the page is still worth showing, and the section simply stays empty.
      error: () => (this.bindings = []),
    });
  }

  // ── Tuning one device (F11.3 / F11.13) ───────────────────────────────
  //
  // A per-device override is the top of the precedence stack, so it is how one bound device differs
  // from its siblings *without* being given a second lifecycle. Since a phase duration may itself be
  // a `@param.` reference, this is also how one device's phase runs shorter than the others'.

  /**
   * Who may write a param here.
   *
   * `user_tunable = false` means "the blueprint drives this through its phase targets" — not
   * "nobody may touch it". It read as the second to an admin too, who had no way to correct one
   * live setup's fixed value short of editing the blueprint and republishing it to every setup
   * derived from it. An admin may write one; the owner still sees it read-only. Ownership is
   * unchanged either way — the API still refuses a setup this account does not own.
   */
  isAdmin(): boolean {
    return this.auth.getCurrentUser()?.role === 'admin';
  }

  canEdit(param: { user_tunable: boolean }): boolean {
    return param.user_tunable || this.isAdmin();
  }

  /** The params offered on the setup's own Settings list: the owner's dials, plus fixed ones for an admin. */
  tunableParams(): InstanceView['params'] {
    return this.instance?.params.filter((p) => this.canEdit(p)) ?? [];
  }

  /**
   * The params worth offering on ONE pot's card.
   *
   * A garden's lifecycles each bring their own settings, and showing all of them on every pot was
   * noise that read as a mistake — a lettuce pot has no use for "days a fruiting pot spends
   * rooting". A param is this pot's business when its own lifecycle references it (as a phase
   * target or as a phase's duration); a param no lifecycle on the page claims is a setup-wide
   * setting and belongs on every card.
   */
  deviceParams(binding: BindingView): InstanceView['params'] {
    const own = this.paramsOfLifecycle(binding);
    const claimedElsewhere = new Set<string>();
    for (const other of this.bindings) {
      if (other.profile_key === binding.profile_key) continue;
      for (const key of this.paramsOfLifecycle(other)) claimedElsewhere.add(key);
    }
    return this.tunableParams().filter((p) => own.has(p.key) || !claimedElsewhere.has(p.key));
  }

  /** Every param one device's lifecycle touches — what its phases set, and what times them. */
  private paramsOfLifecycle(binding: BindingView): Set<string> {
    const keys = new Set<string>();
    for (const phase of binding.phases) {
      for (const key of phase.param_keys ?? []) keys.add(key);
      const duration = phase.duration_value ?? '';
      if (duration.startsWith('@param.')) keys.add(duration.slice('@param.'.length));
    }
    return keys;
  }

  /**
   * Which phase the pot card is *narrowed to*, per device. '' = the whole lifecycle.
   *
   * This is a filter over the list, not a mode a write lands in — picking "Swell" answers "what
   * does this pot do in Swell", and the scope a value is written at is chosen per row, in the row
   * (see `rowScope`). Held per binding rather than globally: two pots are often being read for
   * different reasons, and a shared filter would silently move one card when you touched another.
   */
  tunePhase: Record<number, string | undefined> = {};

  /** Which param row is open for editing, per device. One at a time — the list is the resting state. */
  openTuneParam: Record<number, string | undefined> = {};

  /** The scope an open row writes at, keyed `bindingId:paramKey`. Defaults to the phase on screen. */
  private rowScopes: Record<string, string> = {};

  /**
   * Stepper values not yet sent. A tap moves the number immediately and the write follows once the
   * tapping stops, so holding "+" to get from 35 to 40 is one request, not five.
   */
  private stepDrafts: Record<string, string> = {};
  private stepTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  private rowKey(binding: BindingView, param: ResolvedParam): string {
    return `${binding.binding_id}:${param.key}`;
  }

  phaseFilter(binding: BindingView): string {
    return this.tunePhase[binding.binding_id] ?? '';
  }

  setPhaseFilter(binding: BindingView, phaseKey: string): void {
    this.tunePhase[binding.binding_id] = phaseKey;
    // A row open under the old filter would be editing a scope that is no longer on screen.
    this.openTuneParam[binding.binding_id] = undefined;
  }

  phaseName(binding: BindingView, phaseKey: string): string {
    return binding.phases.find((p) => p.key === phaseKey)?.name ?? phaseKey;
  }

  /** True when this device pins anything inside one phase — what puts a dot on that phase's chip. */
  hasOverridesIn(binding: BindingView, phaseKey: string): boolean {
    return binding.overrides.some((o) => o.phase_key === phaseKey);
  }

  /** The rows the card lists: everything this pot can tune, narrowed to the filtered phase. */
  visibleDeviceParams(binding: BindingView): InstanceView['params'] {
    const params = this.deviceParams(binding);
    const phaseKey = this.phaseFilter(binding);
    if (!phaseKey) return params;
    const phase = binding.phases.find((p) => p.key === phaseKey);
    if (!phase) return params;
    const touched = new Set(phase.param_keys ?? []);
    const duration = phase.duration_value ?? '';
    if (duration.startsWith('@param.')) touched.add(duration.slice('@param.'.length));
    return params.filter((p) => touched.has(p.key));
  }

  /** What this device has pinned for a param at one scope, or null when it has pinned nothing. */
  private pin(binding: BindingView, key: string, scope: string): string | null {
    return binding.overrides.find((o) => o.param_key === key && o.phase_key === scope)?.value ?? null;
  }

  /**
   * The scope this device's pin sits at — '' for every phase, a phase key for one phase, null when
   * the param is inherited. The phase on screen wins, so a filtered card shows that phase's answer.
   */
  private pinnedScope(binding: BindingView, param: ResolvedParam): string | null {
    const phaseKey = this.phaseFilter(binding);
    if (phaseKey && this.pin(binding, param.key, phaseKey) !== null) return phaseKey;
    return this.pin(binding, param.key, '') !== null ? '' : null;
  }

  /**
   * What the row would read without this device's pin — the value the diff strikes through. It is
   * the phase's own target when a phase is on screen, and the setup's resolved value otherwise.
   */
  baselineValue(binding: BindingView, param: ResolvedParam): string {
    const phaseKey = this.phaseFilter(binding);
    if (phaseKey) {
      const cell = param.phases.find((c) => c.phase_key === phaseKey);
      if (cell?.value) return cell.value;
    }
    return param.value ?? '';
  }

  /** What the row reads now: an unsent stepper value, else this device's pin, else the baseline. */
  resolvedValue(binding: BindingView, param: ResolvedParam): string {
    const draft = this.stepDrafts[this.rowKey(binding, param)];
    if (draft !== undefined) return draft;
    const scope = this.pinnedScope(binding, param);
    if (scope !== null) return this.pin(binding, param.key, scope) ?? '';
    return this.baselineValue(binding, param);
  }

  isOverridden(binding: BindingView, param: ResolvedParam): boolean {
    if (this.stepDrafts[this.rowKey(binding, param)] !== undefined) return true;
    return this.pinnedScope(binding, param) !== null;
  }

  /** Only worth striking a baseline through when the two actually differ. */
  showsDiff(binding: BindingView, param: ResolvedParam): boolean {
    return (
      this.isOverridden(binding, param) &&
      this.baselineValue(binding, param) !== '' &&
      this.baselineValue(binding, param) !== this.resolvedValue(binding, param)
    );
  }

  /** Where the row's value came from, in the user's words — the line under the label. */
  rowSource(binding: BindingView, param: ResolvedParam): string {
    const timing = this.durationPhaseName(binding, param);
    const scope = this.stepDrafts[this.rowKey(binding, param)] !== undefined
      ? this.rowScope(binding, param)
      : this.pinnedScope(binding, param);

    if (scope === null) {
      if (!param.user_tunable) return 'Fixed by the blueprint';
      return timing ? `From the blueprint · times ${timing}` : 'From the blueprint';
    }
    if (timing) return `Your value · times ${timing}`;
    return scope === '' ? 'Your value · every phase' : `Your value · ${this.phaseName(binding, scope)} only`;
  }

  /** How many of the card's rows this device disagrees with the blueprint about. */
  overriddenParamCount(binding: BindingView): number {
    return this.deviceParams(binding).filter((p) => this.pinnedScope(binding, p) !== null).length;
  }

  isTuneParamOpen(binding: BindingView, param: ResolvedParam): boolean {
    return this.openTuneParam[binding.binding_id] === param.key;
  }

  toggleTuneParam(binding: BindingView, param: ResolvedParam): void {
    const open = this.isTuneParamOpen(binding, param);
    this.openTuneParam[binding.binding_id] = open ? undefined : param.key;
  }

  /** The scope an open row writes at. Seeded from the phase on screen, then the chips own it. */
  rowScope(binding: BindingView, param: ResolvedParam): string {
    const key = this.rowKey(binding, param);
    if (this.rowScopes[key] === undefined) {
      this.rowScopes[key] = this.pinnedScope(binding, param) ?? this.phaseFilter(binding);
    }
    return this.rowScopes[key];
  }

  setRowScope(binding: BindingView, param: ResolvedParam, scope: string): void {
    this.rowScopes[this.rowKey(binding, param)] = scope;
  }

  /**
   * A param one of this pot's phases uses as its length — called out in the UI because it changes
   * something categorically different from a threshold: it moves when the next phase begins.
   */
  isDurationParam(binding: BindingView, param: ResolvedParam): boolean {
    return this.durationPhaseName(binding, param) !== null;
  }

  /** The phase a duration param clocks, for the row's "times the Swell phase" line. */
  durationPhaseName(binding: BindingView, param: ResolvedParam): string | null {
    const phase = binding.phases.find((p) => p.duration_value === `@param.${param.key}`);
    return phase ? `the ${phase.name} phase` : null;
  }

  /**
   * "20%" but "2 minutes" — a symbol unit reads wrong with a space in front of it and a word unit
   * reads wrong without one. Only needed where value and unit share one run of text; the row's
   * value rail spaces them with flex.
   */
  withUnit(value: string, unit: string | null): string {
    if (!unit) return value;
    return /^[a-z]/i.test(unit) ? `${value} ${unit}` : `${value}${unit}`;
  }

  /** Steppers only make sense over a number; anything else falls back to a plain field. */
  isNumericParam(binding: BindingView, param: ResolvedParam): boolean {
    const value = this.resolvedValue(binding, param);
    return value.trim() !== '' && Number.isFinite(Number(value));
  }

  stepParam(binding: BindingView, param: ResolvedParam, delta: number): void {
    const key = this.rowKey(binding, param);
    const current = Number(this.resolvedValue(binding, param));
    if (!Number.isFinite(current)) return;
    // No min/max on a param yet, so the only floor we can defend is "not negative".
    this.stepDrafts[key] = String(Math.max(0, current + delta));

    if (this.stepTimers[key]) clearTimeout(this.stepTimers[key]);
    this.stepTimers[key] = setTimeout(() => {
      delete this.stepTimers[key];
      const value = this.stepDrafts[key];
      delete this.stepDrafts[key];
      if (value !== undefined) {
        this.setDeviceOverride(binding, param.key, value, this.rowScope(binding, param));
      }
    }, 600);
  }

  /** Hand one param back to the shared lifecycle. */
  revertParam(binding: BindingView, param: ResolvedParam): void {
    const scope = this.pinnedScope(binding, param);
    if (scope === null) return;
    this.setDeviceOverride(binding, param.key, '', scope);
  }

  /**
   * Put the whole device back on the blueprint. Sequential rather than parallel: each call returns
   * the rebuilt binding, and firing them together would let the last response win with a view of
   * the overrides taken before the others landed.
   */
  clearAllOverrides(binding: BindingView): void {
    const pins = [...binding.overrides];
    if (!pins.length) return;
    this.bindingBusy = binding.binding_id;

    const step = (i: number): void => {
      if (i >= pins.length) {
        this.bindingBusy = null;
        this.snackBar.open(`${binding.label} back to the shared lifecycle`, 'Close', {
          duration: 2500,
        });
        return;
      }
      this.blueprints
        .setBindingParam(binding.binding_id, pins[i].param_key, null, pins[i].phase_key || null)
        .subscribe({
          next: (updated) => {
            this.bindings = this.bindings.map((b) =>
              b.binding_id === updated.binding_id ? updated : b,
            );
            step(i + 1);
          },
          error: (err: { error?: { error?: string } }) => {
            this.bindingBusy = null;
            this.snackBar.open(err?.error?.error ?? 'Could not clear those', 'Close', {
              duration: 4000,
            });
          },
        });
    };
    step(0);
  }

  /** Write (or, with an empty value, clear) one pin at an explicit scope. '' = every phase. */
  setDeviceOverride(binding: BindingView, key: string, raw: string, scope: string): void {
    const value = raw.trim();
    if (value === (this.pin(binding, key, scope) ?? '')) return;
    this.bindingBusy = binding.binding_id;
    this.blueprints
      .setBindingParam(binding.binding_id, key, value === '' ? null : value, scope || null)
      .subscribe({
      next: (updated) => {
        this.bindings = this.bindings.map((b) =>
          b.binding_id === updated.binding_id ? updated : b,
        );
        this.bindingBusy = null;
        const where = scope ? ` in ${scope}` : '';
        this.snackBar.open(
          value === ''
            ? `${key} back to the shared value${where}`
            : `${binding.label}: ${key} = ${value}${where}`,
          'Close',
          { duration: 2500 },
        );
      },
      error: (err: { error?: { error?: string } }) => {
        this.bindingBusy = null;
        this.snackBar.open(err?.error?.error ?? 'Could not save that', 'Close', { duration: 4000 });
      },
    });
  }

  /** True once any bound device runs a lifecycle of its own — what the section renders on. */
  get hasDeviceLifecycles(): boolean {
    return this.bindings.length > 0;
  }

  /** Devices the whole setup shares — no lifecycle of their own, so nothing to control per device. */
  sharedBindings(): InstanceView['bindings'] {
    return this.instance?.bindings.filter((b) => b.binding_id === null) ?? [];
  }

  /** "2 of 3 running" — the honest one-line answer when the setup's state is not one thing. */
  deviceSummary(): string {
    const running = this.bindings.filter((b) => b.effective_state === 'running').length;
    return `${running} of ${this.bindings.length} running`;
  }

  startBinding(binding: BindingView): void {
    this.runBindingAction(
      binding,
      this.bindingLifecycle.start(binding),
      binding.lifecycle_state === 'stopped' ? 'Continued' : 'Started',
      'Could not start this device',
    );
  }

  stopBinding(binding: BindingView): void {
    this.runBindingAction(
      binding,
      this.bindingLifecycle.stop(binding),
      'Paused',
      'Could not pause this device',
    );
  }

  resetBinding(binding: BindingView): void {
    this.runBindingAction(
      binding,
      this.bindingLifecycle.reset(binding, this.instance?.profiles ?? []),
      'Reset',
      'Could not reset this device',
    );
  }

  setBindingPhase(binding: BindingView, phaseKey: string): void {
    this.runBindingAction(
      binding,
      this.bindingLifecycle.setPhase(binding, phaseKey),
      'Phase changed',
      'Could not change the phase',
    );
  }

  /**
   * One shape for all four. A null result is the user backing out of a dialog — not an error, so no
   * snackbar; only the busy flag clears.
   */
  private runBindingAction(
    binding: BindingView,
    action: import('rxjs').Observable<BindingView | null>,
    done: string,
    failed: string,
  ): void {
    if (this.bindingBusy !== null) return;
    this.bindingBusy = binding.binding_id;
    action.subscribe({
      next: (updated) => {
        this.bindingBusy = null;
        if (!updated) return;
        this.bindings = this.bindings.map((b) =>
          b.binding_id === updated.binding_id ? updated : b,
        );
        // The setup's own numbers do not move, but its device counts do — and a stopped setup
        // changes every device's effective state, so re-read rather than patch one row.
        if (this.instance) this.loadBindings(this.instance);
        this.snackBar.open(`${done}: ${updated.label}`, 'Close', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.bindingBusy = null;
        this.snackBar.open(err?.error?.error ?? failed, 'Close', { duration: 4000 });
      },
    });
  }

  /** The device's own timer phrase, using the same helper the setup's phase track uses. */
  bindingTimerLabel(binding: BindingView): string {
    const current = binding.phases.find((p) => p.is_current);
    if (!current) return '';
    return currentPhaseTimerLabel(
      current.elapsed_seconds + (binding.effective_state === 'running' ? this.tickOffset : 0),
      current.duration_seconds,
      binding.effective_state === 'running',
    );
  }

  bindingProgress(binding: BindingView): number {
    const current = binding.phases.find((p) => p.is_current);
    if (!current) return 0;
    return progressPercent(
      current.elapsed_seconds + (binding.effective_state === 'running' ? this.tickOffset : 0),
      current.duration_seconds,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  //
  // A setup is built by the wizard and started by the user, because when the real-world process
  // began is not something binding a device can tell us. While it is not running, nothing it
  // derived acts — so the page says so plainly rather than showing a lifecycle that looks live.

  /**
   * Some blueprints declare no phases at all; the lifecycle still applies, the schedule doesn't.
   * The same is true of a setup whose bound devices each own the schedule instead (F11) — the
   * server sends no phases for it, so the phase track simply does not render.
   */
  get hasPhases(): boolean {
    return (this.instance?.phases.length ?? 0) > 0;
  }

  /**
   * Why this setup shows no phase track — the two reasons read identically from `hasPhases` but
   * mean opposite things to a user, so the banner must not describe one as the other.
   *
   *  `static`    nothing in it is scheduled at all (F11.8).
   *  `devices`   it has no phase *of its own* because each bound device has one (F11).
   */
  get phaselessReason(): 'static' | 'devices' {
    return this.instance?.has_own_lifecycle === false ? 'devices' : 'static';
  }

  get notStarted(): boolean {
    return this.instance?.lifecycle_state === 'not_started';
  }

  get stopped(): boolean {
    return this.instance?.lifecycle_state === 'stopped';
  }

  get running(): boolean {
    return this.instance?.lifecycle_state === 'running';
  }

  /** The running phase's timer in one phrase, for the lifecycle card's second line. */
  lifecycleSummary(): string {
    const current = this.instance?.phases.find((p) => p.is_current);
    return current ? this.phaseTimerLabel(current) : '';
  }

  /** Where Start should land by default: where it was parked, else the beginning. */
  private defaultStartPhase(): string | null {
    return this.instance?.current_phase?.key ?? this.instance?.phases[0]?.key ?? null;
  }

  start(): void {
    if (!this.instance || this.busy) return;
    const instance = this.instance;
    this.busy = true;
    this.lifecycle
      .start(instance.id, {
        phases: instance.phases,
        defaultPhaseKey: this.defaultStartPhase(),
        resuming: instance.lifecycle_state === 'stopped',
      })
      .subscribe(
        this.lifecycleHandler(
          instance.lifecycle_state === 'stopped' ? 'Setup continued' : 'Setup started',
          'Could not start this setup',
        ),
      );
  }

  stop(): void {
    if (!this.instance || this.busy) return;
    const { rules, scenes, pipelines } = this.instance.entities;
    this.busy = true;
    this.lifecycle
      .stop(this.instance.id, rules.length + scenes.length + pipelines.length)
      .subscribe(this.lifecycleHandler('Setup paused', 'Could not pause this setup'));
  }

  resetLifecycle(): void {
    if (!this.instance || this.busy) return;
    this.busy = true;
    this.lifecycle
      .reset(this.instance.id)
      .subscribe(this.lifecycleHandler('Lifecycle reset', 'Could not reset'));
  }

  /**
   * One shape for all three: a null result means the user backed out of the confirm, which is not
   * an error and must not raise a snackbar — only clear `busy`.
   */
  private lifecycleHandler(done: string, failed: string) {
    return {
      next: (updated: InstanceView | null) => {
        if (!updated) {
          this.busy = false;
          return;
        }
        this.apply(updated);
        this.snackBar.open(done, 'Close', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.busy = false;
        this.snackBar.open(err?.error?.error ?? failed, 'Close', { duration: 3500 });
      },
    };
  }

  // ── Phases ───────────────────────────────────────────────────────────

  /**
   * Every phase change goes through the dialog, including onto the phase already running (where it
   * means "restart this timer"). The move itself is cheap and reversible; what it does to the
   * timer is not obvious, so it is asked rather than assumed — silently restarting a rolled-back
   * phase is the bug this whole feature answers.
   */
  setPhase(phase: InstancePhase): void {
    // Choosing a phase on a parked setup is what Start is for — there is no second way in.
    if (!this.instance || this.busy || !this.running) return;
    const instance = this.instance;
    const hasNextPhase = instance.phases.some((p) => p.ordinal > phase.ordinal);

    this.dialog
      .open(PhaseChangeDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: { phase, isCurrent: phase.is_current, hasNextPhase },
      })
      .afterClosed()
      .subscribe((result: PhaseChangeResult | undefined) => {
        if (!result) return;
        this.busy = true;
        this.blueprints
          .setPhase(instance.id, phase.key, result.timer, result.elapsed_seconds)
          .subscribe({
            next: (updated) => {
              this.apply(updated);
              const verb = phase.is_current ? 'Restarted' : 'Moved to';
              this.snackBar.open(`${verb} ${phase.name}`, 'Close', { duration: 2500 });
            },
            error: (err) => {
              this.busy = false;
              this.snackBar.open(err?.error?.error ?? 'Could not change phase', 'Close', {
                duration: 3500,
              });
            },
          });
      });
  }

  phaseDuration(phase: InstancePhase): string {
    if (!phase.duration_value || !phase.duration_unit) return 'no limit';
    // A referenced duration (F11.13) is a different number per device, so the stored text says
    // nothing a user would recognise — show what it actually resolved to for THIS owner, which the
    // server already computed into `duration_seconds`.
    const value = phase.duration_value.startsWith('@')
      ? this.durationFromSeconds(phase)
      : phase.duration_value;
    if (value === null) return 'no limit';
    const unit = value === '1' ? phase.duration_unit.replace(/s$/, '') : phase.duration_unit;
    return `${value} ${unit}${phase.auto_advance ? ', then advances' : ''}`;
  }

  /** The resolved duration back in the phase's own unit, so a reference reads like a literal. */
  private durationFromSeconds(phase: InstancePhase): string | null {
    if (!phase.duration_seconds) return null;
    const perUnit: Record<string, number> = {
      seconds: 1,
      minutes: 60,
      hours: 3600,
      days: 86400,
      weeks: 604800,
      months: 2592000,
    };
    const size = perUnit[phase.duration_unit ?? ''];
    return size ? String(phase.duration_seconds / size) : null;
  }

  // ── Phase timers ─────────────────────────────────────────────────────
  //
  // Only the running phase ticks. Every other phase's elapsed is its bank, which is a fixed number
  // until the setup visits it again.

  elapsedSeconds(phase: InstancePhase): number {
    return phase.elapsed_seconds + (phase.is_current ? this.tickOffset : 0);
  }

  /** Seconds left before an auto-advance, or null when the phase has no limit. */
  remainingSeconds(phase: InstancePhase): number | null {
    return remainingSeconds(this.elapsedSeconds(phase), phase.duration_seconds);
  }

  /** 0–100 for the bar. A phase past its duration reads full rather than overflowing. */
  phaseProgress(phase: InstancePhase): number {
    return progressPercent(this.elapsedSeconds(phase), phase.duration_seconds);
  }

  /** The line under the bar — what this phase's timer is doing, in one phrase. */
  phaseTimerLabel(phase: InstancePhase): string {
    if (phase.is_current) {
      return currentPhaseTimerLabel(
        this.elapsedSeconds(phase),
        phase.duration_seconds,
        this.running,
      );
    }
    // Not current: the bank is the whole story, and only worth a line when there is one.
    return phase.accrued_seconds > 0 ? `${formatDuration(phase.accrued_seconds)} banked` : '';
  }

  /** "3d 4h / 14 days" above the bar — only meaningful for a phase that has a limit. */
  phaseProgressLabel(phase: InstancePhase): string {
    if (phase.duration_seconds === null) return '';
    return `${formatDuration(this.elapsedSeconds(phase))} / ${formatDuration(phase.duration_seconds)}`;
  }

  showProgressBar(phase: InstancePhase): boolean {
    return phase.duration_seconds !== null && (phase.is_current || phase.accrued_seconds > 0);
  }

  // ── Settings: the setup's own params ─────────────────────────────────
  //
  // The same list the device cards use, one level up (2026-08-11). It used to be a form: every row
  // a permanently open field beside a sentence-length label, which collided with its own unit on
  // any narrow screen, and a bare "20" that never said whether the blueprint, the phase or you put
  // it there. Per-phase values hid behind a chevron that opened a second stack of fields.
  //
  // Now the list is the resting state and a row becomes an editor only when you pick it, so the
  // width goes to the label and every value keeps a rail of its own. Scope is chosen inside the
  // open row, on chips that each carry that phase's value — which is what the old expand-into-a-
  // grid was for, at a fraction of the space.

  /** Which phase the list is narrowed to. '' = the whole lifecycle. A filter, not a mode. */
  settingsPhase = '';

  /** Which row is open. One at a time — everything else stays readable while you edit. */
  openParam?: string;

  /** The scope an open row writes at, keyed by param key. Seeded from what the row already pins. */
  private paramScopes: Record<string, string> = {};

  /** Stepper taps not yet sent, so holding "+" from 20 to 25 is one request rather than five. */
  private paramStepDrafts: Record<string, string> = {};
  private paramStepTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  private cellOf(param: ResolvedParam, phaseKey: string): ParamPhaseCell | undefined {
    return phaseKey ? param.phases.find((c) => c.phase_key === phaseKey) : undefined;
  }

  /** The rows the tab lists — everything the setup declares, narrowed to the filtered phase. */
  visibleParams(): ResolvedParam[] {
    const params = this.instance?.params ?? [];
    if (!this.settingsPhase) return params;
    return params.filter((p) => this.phaseTouches(p, this.settingsPhase));
  }

  /** A phase has something to say about a param when it targets one, or you pinned one there. */
  phaseTouches(param: ResolvedParam, phaseKey: string): boolean {
    const cell = this.cellOf(param, phaseKey);
    return !!cell && (cell.phase_target !== null || cell.phase_override !== null);
  }

  setSettingsPhase(phaseKey: string): void {
    this.settingsPhase = phaseKey;
    // A row left open under the old filter would be editing a scope no longer on screen.
    this.openParam = undefined;
    this.paramScopes = {};
  }

  settingsPhaseName(phaseKey: string): string {
    return this.instance?.phases.find((p) => p.key === phaseKey)?.name ?? phaseKey;
  }

  /** True when anything is pinned inside one phase — what puts a dot on that phase's chip. */
  hasPinnedIn(phaseKey: string): boolean {
    return (this.instance?.params ?? []).some(
      (p) => (this.cellOf(p, phaseKey)?.phase_override ?? null) !== null,
    );
  }

  /** How many settings the user has taken off the blueprint, at any scope. */
  pinnedParamCount(): number {
    return (this.instance?.params ?? []).filter(
      (p) => p.override_value !== null || p.phases.some((c) => c.phase_override !== null),
    ).length;
  }

  /** How many phases this one param is pinned in — the count the row's chip carries. */
  pinnedPhaseCount(param: ResolvedParam): number {
    return param.phases.filter((c) => c.phase_override !== null).length;
  }

  /** What the row reads: resolved for the phase on screen, or for now. */
  paramRowValue(param: ResolvedParam): string {
    const draft = this.paramStepDrafts[param.key];
    if (draft !== undefined) return draft;
    const cell = this.cellOf(param, this.settingsPhase);
    return (cell ? cell.value : param.value) ?? '';
  }

  /** Which layer supplied what the row reads — the answer the old bare number never gave. */
  private rowSourceOf(param: ResolvedParam): string {
    const cell = this.cellOf(param, this.settingsPhase);
    return cell ? cell.source : param.source;
  }

  /** True when the row reads a value the user put there, at whichever scope the row is showing. */
  rowIsSet(param: ResolvedParam): boolean {
    if (this.paramStepDrafts[param.key] !== undefined) return true;
    const source = this.rowSourceOf(param);
    return source === 'override' || source === 'phase_override';
  }

  /** Where the row's value came from, in the user's words — the line under the label. */
  paramRowSource(param: ResolvedParam): string {
    const here = this.settingsPhase
      ? this.settingsPhaseName(this.settingsPhase)
      : (this.instance?.current_phase?.name ?? 'this phase');
    switch (this.rowSourceOf(param)) {
      case 'phase_override':
        return `Your value · ${here} only`;
      case 'override':
        return 'Your value · every phase';
      case 'phase':
        return `From the ${here} phase`;
      default:
        return param.user_tunable ? 'From the blueprint' : 'Fixed by the blueprint';
    }
  }

  /** What the row would read with the user's pins taken away — the value the diff strikes out. */
  blueprintValue(param: ResolvedParam): string {
    const cell = this.cellOf(param, this.settingsPhase);
    if (cell) return cell.phase_target ?? param.default_value;
    return param.phase_value ?? param.default_value;
  }

  /** Only worth striking a value through when the two actually differ. */
  rowShowsDiff(param: ResolvedParam): boolean {
    if (!this.rowIsSet(param)) return false;
    const base = this.blueprintValue(param);
    return base !== '' && base !== this.paramRowValue(param);
  }

  isParamOpen(param: ResolvedParam): boolean {
    return this.openParam === param.key;
  }

  toggleParam(param: ResolvedParam): void {
    this.openParam = this.isParamOpen(param) ? undefined : param.key;
  }

  /** The scope the open row writes at: what it already pins, else the phase on screen. */
  paramScope(param: ResolvedParam): string {
    if (this.paramScopes[param.key] === undefined) {
      this.paramScopes[param.key] = this.pinnedScopeOf(param) ?? this.settingsPhase;
    }
    return this.paramScopes[param.key];
  }

  setParamScope(param: ResolvedParam, scope: string): void {
    this.paramScopes[param.key] = scope;
  }

  /** Where this param's pin sits — the phase on screen first, then all-phases, then any phase. */
  private pinnedScopeOf(param: ResolvedParam): string | null {
    const here = this.settingsPhase || (param.phases.find((c) => c.is_current)?.phase_key ?? '');
    if (here && this.cellOf(param, here)?.phase_override != null) return here;
    if (param.override_value !== null) return '';
    return param.phases.find((c) => c.phase_override !== null)?.phase_key ?? null;
  }

  /** What the editor shows: the value at the scope the chips have selected. */
  scopeValue(param: ResolvedParam): string {
    const draft = this.paramStepDrafts[param.key];
    if (draft !== undefined) return draft;
    const cell = this.cellOf(param, this.paramScope(param));
    if (cell) return cell.value ?? '';
    return param.override_value ?? param.value ?? '';
  }

  /** What that scope falls back to once its pin is cleared — what the revert line offers. */
  scopeBaseline(param: ResolvedParam): string {
    const cell = this.cellOf(param, this.paramScope(param));
    if (cell) return cell.phase_target ?? param.override_value ?? param.default_value;
    return param.phase_value ?? param.default_value;
  }

  /** A scope is only clearable when the user pinned *that* scope, not an inherited value. */
  scopePinned(param: ResolvedParam): boolean {
    const cell = this.cellOf(param, this.paramScope(param));
    return cell ? cell.phase_override !== null : param.override_value !== null;
  }

  /** What one phase's chip reads, so picking a scope never means guessing what is there now. */
  chipValue(param: ResolvedParam, cell: ParamPhaseCell | null): string {
    const value = cell ? cell.value : (param.override_value ?? param.default_value);
    return value === null || value === '' ? '—' : this.withUnit(value, param.unit);
  }

  // The right control for the shape of the value: a number gets a stepper, a switch gets two
  // options, a time gets a clock. Everything else falls back to a field — the blueprint does not
  // declare a param kind yet, so the value on screen is the only evidence there is.

  isBooleanParam(param: ResolvedParam): boolean {
    return ['on', 'off', 'true', 'false'].includes(this.scopeValue(param).trim().toLowerCase());
  }

  isTimeParam(param: ResolvedParam): boolean {
    return /^\d{1,2}:\d{2}$/.test(this.scopeValue(param).trim());
  }

  isNumericParamValue(param: ResolvedParam): boolean {
    const value = this.scopeValue(param).trim();
    return value !== '' && Number.isFinite(Number(value));
  }

  boolIsOn(param: ResolvedParam): boolean {
    const value = this.scopeValue(param).trim().toLowerCase();
    return value === 'on' || value === 'true';
  }

  /** Answer in the vocabulary the value already uses — a blueprint saying "true" keeps saying it. */
  boolWord(param: ResolvedParam, on: boolean): string {
    const current = this.scopeValue(param).trim().toLowerCase();
    const onOff = current === 'on' || current === 'off';
    if (onOff) return on ? 'on' : 'off';
    return on ? 'true' : 'false';
  }

  stepSettingsParam(param: ResolvedParam, delta: number): void {
    const current = Number(this.scopeValue(param));
    if (!Number.isFinite(current)) return;
    // No min/max on a param yet, so the only floor we can defend is "not negative".
    this.paramStepDrafts[param.key] = String(Math.max(0, current + delta));

    if (this.paramStepTimers[param.key]) clearTimeout(this.paramStepTimers[param.key]);
    this.paramStepTimers[param.key] = setTimeout(() => {
      delete this.paramStepTimers[param.key];
      const value = this.paramStepDrafts[param.key];
      delete this.paramStepDrafts[param.key];
      if (value !== undefined) this.setParamValue(param, value);
    }, 600);
  }

  /** Write (or, with an empty value, clear) this param at the scope the row has selected. */
  setParamValue(param: ResolvedParam, raw: string): void {
    if (!this.instance || this.busy) return;
    const value = raw.trim();
    const scope = this.paramScope(param);
    const cell = this.cellOf(param, scope);
    const pinned = (cell ? cell.phase_override : param.override_value) ?? '';
    // Unchanged, or retyping exactly what it already resolves to — nothing to pin.
    if (value === pinned || (pinned === '' && value === this.scopeValue(param).trim())) return;
    this.write(param.key, value === '' ? null : value, scope || null);
  }

  /** Hand one param back to the blueprint at the scope on screen. */
  revertParamScope(param: ResolvedParam): void {
    if (!this.instance || this.busy || !this.scopePinned(param)) return;
    this.write(param.key, null, this.paramScope(param) || null);
  }

  /**
   * Put every setting back on the blueprint. Sequential rather than parallel: each call returns the
   * rebuilt setup, and firing them together would let the last response win with a view of the
   * overrides taken before the others landed.
   */
  clearAllParams(): void {
    if (!this.instance || this.busy) return;
    const pins: { key: string; phase: string | null }[] = [];
    for (const param of this.instance.params) {
      if (param.override_value !== null) pins.push({ key: param.key, phase: null });
      for (const cell of param.phases) {
        if (cell.phase_override !== null) pins.push({ key: param.key, phase: cell.phase_key });
      }
    }
    if (!pins.length) return;

    this.busy = true;
    const step = (i: number): void => {
      if (i >= pins.length) {
        this.busy = false;
        this.snackBar.open('Back to the blueprint', 'Close', { duration: 2500 });
        return;
      }
      this.blueprints.setParam(this.instance!.id, pins[i].key, null, pins[i].phase).subscribe({
        next: (updated) => {
          this.apply(updated);
          this.busy = true;
          step(i + 1);
        },
        error: (err: { error?: { error?: string } }) => {
          this.busy = false;
          this.snackBar.open(err?.error?.error ?? 'Could not clear those', 'Close', {
            duration: 4000,
          });
        },
      });
    };
    step(0);
  }

  private write(key: string, value: string | null, phaseKey: string | null): void {
    this.busy = true;
    this.blueprints.setParam(this.instance!.id, key, value, phaseKey).subscribe({
      next: (updated) => {
        this.apply(updated);
        const scope = phaseKey ? 'for this phase' : 'for every phase';
        this.snackBar.open(value === null ? 'Back to the blueprint' : `Saved ${scope}`, 'Close', {
          duration: 2000,
        });
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
