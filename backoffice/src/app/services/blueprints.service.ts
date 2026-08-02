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
  sealed_template: string;
  candidates: SlotCandidate[];
  /** The devices the wizard pre-fills without asking — all candidates when they fit the slot. */
  auto_bind: number[];
}

export interface DerivePreview {
  blueprint_id: number;
  key: string;
  name: string;
  version: number;
  slots: SlotMatch[];
  /** Required slots with no matching device — the blueprint cannot be derived until resolved. */
  unmet: string[];
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
export type ParamSource = 'phase_override' | 'override' | 'phase' | 'default';

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
  duration_value: number | null;
  duration_unit: string | null;
  auto_advance: boolean;
  is_current: boolean;
  /** The duration in one unit — null means no limit, so the phase never elapses. */
  duration_seconds: number | null;
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
  blueprint_version_behind: boolean;
  area: { id: number; name: string } | null;
  /**
   * Whether this setup is live. Deriving builds it; the user starts it, saying which phase and how
   * far into it, because connecting a device carries none of that. Nothing the setup derived acts
   * unless this is `running` — emergency rules included.
   */
  lifecycle_state: LifecycleState;
  current_phase: { id: number; key: string; name: string; ordinal: number } | null;
  phase_started_at: string | null;
  phases: InstancePhase[];
  bindings: { slot_key: string; label: string; user_device_id: number; auto_bound: boolean }[];
  params: ResolvedParam[];
  entities: {
    scenes: InstanceEntity[];
    rules: InstanceEntity[];
    pipelines: InstanceEntity[];
  };
}

/**
 * One row of the setups list. Carries enough lifecycle to read a setup at a glance — state, phase,
 * and that phase's timer — so the list can tell a running setup from a parked one without opening
 * it. Only the *current* phase is here; choosing a different one needs them all, so Start from the
 * list loads the instance first.
 */
export interface InstanceSummary {
  id: number;
  name: string;
  blueprint_key: string;
  lifecycle_state: LifecycleState;
  /** False for a blueprint with no phases: nothing to start, stop or show. */
  has_phases: boolean;
  current_phase: { key: string; name: string } | null;
  duration_seconds: number | null;
  accrued_seconds: number;
  elapsed_seconds: number;
  started_at: string | null;
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

  /** Omit a slot's binding to accept the auto-bind; pass one to choose between candidates. */
  derive(
    blueprintId: number,
    name: string,
    bindings?: { slot_key: string; user_device_id: number }[],
  ): Observable<DeriveResult> {
    return this.http.post<DeriveResult>(`${this.apiUrl}/api/blueprints/${blueprintId}/derive`, {
      name,
      bindings,
    });
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
