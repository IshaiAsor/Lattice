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
}
