import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

export interface AdminDeviceType {
  id: number;
  type: string;
  version: string;
  default_name: string;
}

export interface AdminCatalogCapability {
  id: number;
  device_id: number;
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  configurable_pins: { key: string; label: string; mode: string }[];
  min_telemetry_interval_ms: number | null;
  google_action_type: string | null;
  google_traits: string[] | null;
}

export interface AdminTraitView {
  id: number;
  value: string;
  is_default: boolean;
}

// ─── Sealed device templates ──────────────────────────────────────────────
export interface SealedIdentity {
  id: number;
  type: string;
  version: string;
  default_name: string;
}
export interface SealedTemplateTarget {
  device_type: string;
  version_min: string;
  version_max: string;
}
export interface SealedTemplateEntryPin {
  pin_slot_key: string;
  pin_number: number;
}
export interface SealedTemplateEntryBehavior {
  behavior: string;
  interval_ms?: number | null;
  camera_resolution?: string | null;
  camera_transport?: string | null;
}
export interface SealedTemplateEntry {
  capability_key: string;
  // On write: the capability's base mqtt_action_name (server suffixes _2/_3… per repeated
  // instance). On read: the resolved unique name. A capability may appear more than once.
  mqtt_action_name?: string;
  action_label: string;
  default_trait_value?: string | null;
  sort_order?: number;
  pins: SealedTemplateEntryPin[];
  behaviors: SealedTemplateEntryBehavior[];
}
export interface SealedTemplate {
  id: number;
  name: string;
  status: 'draft' | 'released';
  targets: SealedTemplateTarget[];
  entries: SealedTemplateEntry[];
}
export interface SealedTemplateSummary {
  id: number;
  name: string;
  status: 'draft' | 'released';
  targets: SealedTemplateTarget[];
  _count: { entries: number };
}

export interface AdminDeviceAction {
  id: number;
  device_id: number;
  default_name: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  implementation_type: string;
  pins: { key: string; label: string; mode: string }[];
  telemetry_interval_ms: number | null;
  google_action_type: string | null;
  google_traits: AdminTraitView[];
}

@Injectable({ providedIn: 'root' })
export class AdminDeviceConfigService {
  private base = `${apiUrl()}/api/admin/catalog`;
  private http = inject(HttpClient);

  getDeviceTypes(): Observable<AdminDeviceType[]> {
    return this.http.get<AdminDeviceType[]>(`${this.base}/devices`);
  }

  getCapabilities(deviceId: number): Observable<AdminCatalogCapability[]> {
    return this.http.get<AdminCatalogCapability[]>(`${this.base}/devices/${deviceId}/capabilities`);
  }

  getActions(deviceId: number): Observable<AdminDeviceAction[]> {
    return this.http.get<AdminDeviceAction[]>(`${this.base}/devices/${deviceId}/actions`);
  }

  setDefaultTrait(capabilityId: number, traitId: number): Observable<void> {
    return this.http.patch<void>(`${this.base}/capabilities/${capabilityId}/traits/${traitId}/default`, {});
  }

  // ─── Sealed device templates ────────────────────────────────────────────
  getSealedIdentities(): Observable<SealedIdentity[]> {
    return this.http.get<SealedIdentity[]>(`${this.base}/sealed/identities`);
  }
  listSealedTemplates(): Observable<SealedTemplateSummary[]> {
    return this.http.get<SealedTemplateSummary[]>(`${this.base}/sealed/templates`);
  }
  getSealedTemplate(id: number): Observable<SealedTemplate> {
    return this.http.get<SealedTemplate>(`${this.base}/sealed/templates/${id}`);
  }
  createSealedTemplate(name: string): Observable<SealedTemplate> {
    return this.http.post<SealedTemplate>(`${this.base}/sealed/templates`, { name });
  }
  updateSealedTemplate(
    id: number,
    body: { name?: string; targets?: SealedTemplateTarget[]; entries?: SealedTemplateEntry[] },
  ): Observable<SealedTemplate> {
    return this.http.patch<SealedTemplate>(`${this.base}/sealed/templates/${id}`, body);
  }
  deleteSealedTemplate(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/sealed/templates/${id}`);
  }
  releaseSealedTemplate(id: number): Observable<{ status: string; affected: number }> {
    return this.http.post<{ status: string; affected: number }>(
      `${this.base}/sealed/templates/${id}/release`,
      {},
    );
  }
}
