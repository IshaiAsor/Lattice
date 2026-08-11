import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

// Blueprints (F10) — an admin-authored description of a whole multi-device setup that a user
// *derives* into their own live "setup" (a BlueprintInstance): an Area holding the bound devices,
// plus the scenes/rules/pipelines the blueprint describes.
//
// Two ideas the shapes below only hint at:
//   - Derived automations store *references* (`@phase.level.min`), not values. Changing phase or
//     setting an override changes what they resolve to without rewriting a single rule.
//   - Editing a derived entity marks it `user_modified`; reconcile then leaves it alone and the
//     instance page offers a reset. That is what "drift" means here.

export interface SlotCandidate {
  user_device_id: number;
  name: string;
  /** Unique per board — the only way to tell two same-type sealed devices apart. */
  mac_id: string;
  device_type: string;
  version: string;
  free: boolean;
}

export interface SlotMatch {
  slot_key: string;
  label: string;
  required: boolean;
  /** How many devices this slot binds. max_count > 1 is a multi-device slot. */
  min_count: number;
  max_count: number;
  /** Each device bound here runs its own lifecycle, so the wizard must ask which profile (F11). */
  profiled: boolean;
  sealed_template: string;
  candidates: SlotCandidate[];
  /** The devices the wizard pre-fills without asking — all candidates when they fit the slot. */
  auto_bind: number[];
}

/** A lifecycle a profiled slot's device can be put on (F11). */
export interface ProfileOption {
  key: string;
  label: string;
}

/**
 * One question the blueprint asks before it can be set up (F11.6).
 *
 * `scope: 'binding'` is asked once per bound device of `slot_key`; `setup` once for the whole
 * setup. A select option carrying `profile_key` answers two things at once — what the user said,
 * and which lifecycle that device follows — so the wizard never asks for the profile separately.
 */
export interface FieldPrompt {
  key: string;
  label: string;
  help_text: string | null;
  input_type: 'text' | 'number' | 'select' | 'date' | 'boolean' | string;
  scope: 'setup' | 'binding' | string;
  slot_key: string | null;
  required: boolean;
  default_value: string | null;
  options: { value: string; label: string; profile_key: string | null }[];
}

export interface DerivePreview {
  blueprint_id: number;
  key: string;
  name: string;
  version: number;
  slots: SlotMatch[];
  /** Lifecycles a profiled slot's devices can be put on. Empty when the blueprint has none. */
  profiles: ProfileOption[];
  /** The form to fill in before deriving. Empty when the blueprint asks nothing. */
  fields: FieldPrompt[];
  /** Required slots with no matching device — the blueprint cannot be derived until resolved. */
  unmet: string[];
}

/** What one device is bound as: which lifecycle it follows and what the user answered about it. */
export interface DeriveBinding {
  slot_key: string;
  user_device_id: number;
  profile_key?: string | null;
  label?: string | null;
  field_values?: { field_key: string; value: string }[];
}

export interface DeriveResult {
  instance_id: number;
  area_id: number;
  name: string;
  /** `not_started` for anything with phases — deriving builds a setup, it does not start it. */
  lifecycle_state: LifecycleState;
  /** Always null: nothing is entered until the user starts the setup. */
  current_phase: string | null;
  /** The phase Start offers first, so the wizard can name where it is about to begin. */
  first_phase: string | null;
  bindings: { slot_key: string; user_device_id: number; auto_bound: boolean }[];
  created: { scenes: number; rules: number; pipelines: number };
}

/** Which layer supplied a value — the resolver's own answer, not the UI's guess. */
export type ParamSource =
  | 'binding_phase_override'
  | 'binding_override'
  | 'phase_override'
  | 'override'
  | 'phase'
  | 'default';

/** What one param resolves to *in one phase*, whether or not the instance is currently in it. */
export interface ParamPhaseCell {
  phase_key: string;
  phase_name: string;
  is_current: boolean;
  value: string | null;
  source: ParamSource;
  phase_target: string | null;
  phase_override: string | null;
}

export interface ResolvedParam {
  key: string;
  label: string;
  unit: string | null;
  user_tunable: boolean;
  value: string | null;
  source: ParamSource;
  default_value: string;
  phase_value: string | null;
  override_value: string | null;
  /** Every phase resolved up front, so the whole lifecycle is visible without advancing into it. */
  phases: ParamPhaseCell[];
}

/** What the phase being entered starts its timer from. */
export type PhaseTimerMode = 'reset' | 'resume' | 'at';

/** Whether the setup's lifecycle has been started, is parked, or is running. */
export type LifecycleState = 'not_started' | 'running' | 'stopped';

export interface InstancePhase {
  id: number;
  key: string;
  name: string;
  ordinal: number;
  /** As authored: a literal ("7") or an `@param.` reference the owner resolves for itself. */
  duration_value: string | null;
  duration_unit: string | null;
  auto_advance: boolean;
  is_current: boolean;
  /** The duration in one unit, resolved for THIS owner — null means no limit. */
  duration_seconds: number | null;
  /** Params this phase sets. Absent on the setup-level view, which has no siblings to tell apart. */
  param_keys?: string[];
  /** Banked from previous visits: exactly what "Resume" would restore. */
  accrued_seconds: number;
  /**
   * Banked plus the run in flight, **as of the response**. The page ticks this up with its own
   * wall-clock delta since load rather than re-reading it, so a browser clock that disagrees with
   * the server can never skew the countdown.
   */
  elapsed_seconds: number;
  /** When the current visit began; null for every phase the setup is not in right now. */
  started_at: string | null;
}

export interface InstanceEntity {
  id: number;
  name: string;
  blueprint_key: string | null;
  user_modified: boolean;
  enabled?: boolean;
}

export interface InstanceView {
  id: number;
  name: string;
  blueprint: { id: number; key: string; name: string; version: number };
  /**
   * A static setup: no slot in it has phases, so nothing is scheduled anywhere. It still starts
   * and stops — pausing holds its automations — it just has no phase track and no timers.
   */
  is_static: boolean;
  blueprint_version_behind: boolean;
  area: { id: number; name: string } | null;
  /**
   * Whether this setup is live. Deriving builds it; the user starts it, saying which phase and how
   * far into it, because connecting a device carries none of that. Nothing the setup derived acts
   * unless this is `running` — emergency rules included.
   */
  lifecycle_state: LifecycleState;
  /** The lifecycles this blueprint offers — what a bound device can be put on (F11). */
  profiles: ProfileOption[];
  /**
   * True when the setup itself walks a lifecycle. False once any slot is profiled: the phases then
   * belong to the individual bound devices, and the setup only starts and stops.
   */
  has_own_lifecycle: boolean;
  current_phase: { id: number; key: string; name: string; ordinal: number } | null;
  phase_started_at: string | null;
  phases: InstancePhase[];
  bindings: {
    slot_key: string;
    label: string;
    user_device_id: number;
    auto_bound: boolean;
    /** Set when this device runs a lifecycle of its own. */
    binding_id: number | null;
    profile_key: string | null;
  }[];
  params: ResolvedParam[];
  entities: {
    scenes: InstanceEntity[];
    rules: InstanceEntity[];
    pipelines: InstanceEntity[];
  };
}

/**
 * One phase of a track — a lifecycle drawn rather than edited. Enough to size a segment and fill
 * it, and nothing to act on: moving to a phase needs the instance, which the detail page loads.
 */
export interface PhaseTrackItem {
  key: string;
  name: string;
  ordinal: number;
  duration_seconds: number | null;
  accrued_seconds: number;
  /** Bank plus the run in flight. Equals `accrued_seconds` unless this is the current phase. */
  elapsed_seconds: number;
  is_current: boolean;
}

/** One bound device's whole lifecycle, as the setups list and the dashboard tile draw it (F11.4). */
export interface DeviceTrack {
  binding_id: number;
  /** Which device this track is of — how a caller ties the track to that device's actions. */
  user_device_id: number;
  label: string;
  profile_label: string | null;
  lifecycle_state: LifecycleState;
  /** Running only while this device *and* its setup are — never "live inside a stopped setup". */
  effective_state: LifecycleState;
  current_phase: { key: string; name: string } | null;
  duration_seconds: number | null;
  elapsed_seconds: number;
  started_at: string | null;
  phases: PhaseTrackItem[];
}

/**
 * One row of the setups list. Carries enough lifecycle to read a setup at a glance — state, the
 * whole phase track, and each bound device's position in its own — so the list can tell a running
 * setup from a parked one, and a nearly-finished one from a just-started one, without opening it.
 * Tracks are for drawing; changing a phase needs the instance, so Start from the list fetches it.
 */
export interface InstanceSummary {
  id: number;
  name: string;
  blueprint_key: string;
  lifecycle_state: LifecycleState;
  /**
   * False when the setup itself has no lifecycle — a blueprint with no phases, or one whose bound
   * devices each run their own (F11). Either way there is nothing to start, stop or show here.
   */
  has_phases: boolean;
  current_phase: { key: string; name: string } | null;
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  started_at: string | null;
  /** Devices running a lifecycle of their own, and how many are actually running (F11.4). */
  devices: { total: number; running: number };
  /** The setup's own track. Empty when its devices own the lifecycle instead. */
  phases: PhaseTrackItem[];
  /** One track per profiled binding. Empty when no bound device carries a lifecycle. */
  device_tracks: DeviceTrack[];
  /**
   * Every device bound to this setup — how the dashboard tells which of the user's actions belong
   * to it. Not the setup's area: a user can drop unrelated devices into an area, a binding is exact.
   */
  device_ids: number[];
}

/**
 * One bound device that runs a lifecycle of its own (F11) — a setup can hold several, each on a
 * different profile and at a different point in it.
 */
export interface BindingView {
  binding_id: number;
  slot_key: string;
  user_device_id: number;
  label: string;
  profile_key: string | null;
  profile_label: string | null;
  lifecycle_state: LifecycleState;
  /**
   * Running only while this device **and** its setup are — one value so the page cannot show a
   * device as live inside a stopped setup.
   */
  effective_state: LifecycleState;
  current_phase: { key: string; name: string; ordinal: number } | null;
  /** Values pinned to THIS device — the top of the precedence stack. '' = every phase. */
  overrides: { param_key: string; phase_key: string; value: string }[];
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  started_at: string | null;
  /** The whole track, in the same shape the setup uses, so both reuse the same dialogs. */
  phases: InstancePhase[];
}

export interface ReconcileChange {
  kind: 'scene' | 'rule' | 'pipeline';
  blueprint_key: string;
  name: string;
  action: 'created' | 'updated' | 'skipped_user_modified' | 'disabled' | 'unresolvable';
  detail?: string;
}

export interface ReconcileResult {
  instance_id: number;
  name: string;
  from_version: number;
  to_version: number;
  changes: ReconcileChange[];
}

export interface DriftReport {
  instance_id: number;
  entities: (InstanceEntity & { kind: 'scene' | 'rule' | 'pipeline' })[];
  overridden_params: { param_key: string; value: string }[];
  blueprint_version_behind: boolean;
}

@Injectable({ providedIn: 'root' })
export class BlueprintsService {
  private apiUrl = apiUrl();
  private http = inject(HttpClient);

  /** Published blueprints, each already matched against this user's fleet. */
  listDerivable(): Observable<DerivePreview[]> {
    return this.http.get<DerivePreview[]>(`${this.apiUrl}/api/blueprints`);
  }

  preview(blueprintId: number): Observable<DerivePreview> {
    return this.http.get<DerivePreview>(`${this.apiUrl}/api/blueprints/${blueprintId}/preview`);
  }

  /**
   * Omit a slot's binding to accept the auto-bind; pass one to choose between candidates.
   * `fieldValues` answers the blueprint's setup-scoped questions (F11.6); per-device answers ride
   * on their own binding.
   */
  derive(
    blueprintId: number,
    name: string,
    bindings?: DeriveBinding[],
    fieldValues?: { field_key: string; value: string }[],
  ): Observable<DeriveResult> {
    return this.http.post<DeriveResult>(`${this.apiUrl}/api/blueprints/${blueprintId}/derive`, {
      name,
      bindings,
      ...(fieldValues?.length ? { field_values: fieldValues } : {}),
    });
  }

  // ── Per-binding lifecycles (F11) ──────────────────────────────────────────────────────────
  //
  // The exact counterparts of the setup-level calls above, one level down: each bound device of a
  // profiled slot is started, stopped, re-profiled and moved between phases on its own.

  listBindings(instanceId: number): Observable<BindingView[]> {
    return this.http.get<BindingView[]>(
      `${this.apiUrl}/api/blueprints/instances/${instanceId}/bindings`,
    );
  }

  startBinding(
    bindingId: number,
    phaseKey?: string | null,
    timer: PhaseTimerMode = 'reset',
    elapsedSeconds?: number,
  ): Observable<BindingView> {
    return this.http.post<BindingView>(`${this.apiUrl}/api/blueprints/bindings/${bindingId}/start`, {
      phase_key: phaseKey ?? null,
      timer,
      ...(timer === 'at' ? { elapsed_seconds: elapsedSeconds ?? 0 } : {}),
    });
  }

  stopBinding(bindingId: number): Observable<BindingView> {
    return this.http.post<BindingView>(
      `${this.apiUrl}/api/blueprints/bindings/${bindingId}/stop`,
      {},
    );
  }

  /** Back to not-started, discarding this device's banked time. `profileKey` re-profiles it. */
  resetBinding(bindingId: number, profileKey?: string | null): Observable<BindingView> {
    return this.http.post<BindingView>(`${this.apiUrl}/api/blueprints/bindings/${bindingId}/reset`, {
      profile_key: profileKey ?? null,
    });
  }

  setBindingPhase(
    bindingId: number,
    phaseKey: string,
    timer: PhaseTimerMode = 'reset',
    elapsedSeconds?: number,
  ): Observable<BindingView> {
    return this.http.put<BindingView>(`${this.apiUrl}/api/blueprints/bindings/${bindingId}/phase`, {
      phase_key: phaseKey,
      timer,
      ...(timer === 'at' ? { elapsed_seconds: elapsedSeconds ?? 0 } : {}),
    });
  }

  /**
   * Pin a parameter for ONE device (F11.3). This is how two devices on the same lifecycle differ —
   * including how long a phase lasts, when the blueprint's duration is a `@param.` reference.
   * `value: null` clears the pin and the layer beneath applies again.
   */
  setBindingParam(
    bindingId: number,
    key: string,
    value: string | null,
    phaseKey?: string | null,
  ): Observable<BindingView> {
    return this.http.put<BindingView>(
      `${this.apiUrl}/api/blueprints/bindings/${bindingId}/params/${encodeURIComponent(key)}`,
      { value, phase_key: phaseKey ?? null },
    );
  }

  listInstances(): Observable<InstanceSummary[]> {
    return this.http.get<InstanceSummary[]>(`${this.apiUrl}/api/blueprints/instances`);
  }

  getInstance(id: number): Observable<InstanceView> {
    return this.http.get<InstanceView>(`${this.apiUrl}/api/blueprints/instances/${id}`);
  }

  /**
   * `timer` decides what the phase being entered counts from: `reset` from zero, `resume` from the
   * time it banked on an earlier visit, `at` from `elapsedSeconds`. Leaving a phase always banks
   * its run, whichever mode is used.
   */
  setPhase(
    id: number,
    phaseKey: string,
    timer: PhaseTimerMode = 'reset',
    elapsedSeconds?: number,
  ): Observable<InstanceView> {
    return this.http.put<InstanceView>(`${this.apiUrl}/api/blueprints/instances/${id}/phase`, {
      phase_key: phaseKey,
      timer,
      ...(timer === 'at' ? { elapsed_seconds: elapsedSeconds ?? 0 } : {}),
    });
  }

  /**
   * `value: null` clears the override and lets the layer beneath apply again. `phaseKey` scopes the
   * write to one phase; omit it to set the value for every phase.
   */
  setParam(
    id: number,
    key: string,
    value: string | null,
    phaseKey?: string | null,
  ): Observable<InstanceView> {
    return this.http.put<InstanceView>(
      `${this.apiUrl}/api/blueprints/instances/${id}/params/${encodeURIComponent(key)}`,
      { value, phase_key: phaseKey ?? null },
    );
  }

  /**
   * Start (or resume) the lifecycle. `phaseKey` defaults server-side to where it was parked, else
   * the first phase; `timer`/`elapsedSeconds` say how far into that phase the process already is.
   */
  start(
    id: number,
    phaseKey?: string | null,
    timer: PhaseTimerMode = 'reset',
    elapsedSeconds?: number,
  ): Observable<InstanceView> {
    return this.http.post<InstanceView>(`${this.apiUrl}/api/blueprints/instances/${id}/start`, {
      phase_key: phaseKey ?? null,
      timer,
      ...(timer === 'at' ? { elapsed_seconds: elapsedSeconds ?? 0 } : {}),
    });
  }

  /** Park it: banks the run, stops the clock, holds every automation the setup owns. */
  stop(id: number): Observable<InstanceView> {
    return this.http.post<InstanceView>(`${this.apiUrl}/api/blueprints/instances/${id}/stop`, {});
  }

  /** Back to never-started. Discards the time banks only — devices and tuning are kept. */
  resetLifecycle(id: number): Observable<InstanceView> {
    return this.http.post<InstanceView>(
      `${this.apiUrl}/api/blueprints/instances/${id}/reset-lifecycle`,
      {},
    );
  }

  drift(id: number): Observable<DriftReport> {
    return this.http.get<DriftReport>(`${this.apiUrl}/api/blueprints/instances/${id}/drift`);
  }

  reconcile(id: number): Observable<ReconcileResult> {
    return this.http.post<ReconcileResult>(
      `${this.apiUrl}/api/blueprints/instances/${id}/reconcile`,
      {},
    );
  }

  resetEntity(
    id: number,
    kind: 'scene' | 'rule' | 'pipeline',
    entityId: number,
  ): Observable<ReconcileResult> {
    return this.http.post<ReconcileResult>(
      `${this.apiUrl}/api/blueprints/instances/${id}/reset/${kind}/${entityId}`,
      {},
    );
  }

  removeInstance(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/blueprints/instances/${id}`);
  }
}
