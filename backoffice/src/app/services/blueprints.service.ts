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
  current_phase: string | null;
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

export interface InstancePhase {
  id: number;
  key: string;
  name: string;
  ordinal: number;
  duration_value: number | null;
  duration_unit: string | null;
  auto_advance: boolean;
  is_current: boolean;
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

export interface InstanceSummary {
  id: number;
  name: string;
  blueprint_key: string;
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

  setPhase(id: number, phaseKey: string): Observable<InstanceView> {
    return this.http.put<InstanceView>(`${this.apiUrl}/api/blueprints/instances/${id}/phase`, {
      phase_key: phaseKey,
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
