import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';

export interface AdminDeviceType {
  id: number;
  type: string;
  version: string;
  default_name: string;
}

export interface AdminDeviceAction {
  id: number;
  device_id: number;
  default_name: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  implementation_type: string;
  pins: { pinNumber: number; pinMode: string }[];
  telemetry_interval_ms: number | null;
  google_type_id: number | null;
  google_trait_ids: number[];
}

@Injectable({ providedIn: 'root' })
export class AdminDeviceConfigService {
  private base = `${environment.apiUrl}/api/admin/device-config`;
  private http = inject(HttpClient);

  // Device types
  getDeviceTypes(): Observable<AdminDeviceType[]> {
    return this.http.get<AdminDeviceType[]>(`${this.base}/devices`);
  }

  createDeviceType(data: Omit<AdminDeviceType, 'id'>): Observable<AdminDeviceType> {
    return this.http.post<AdminDeviceType>(`${this.base}/devices`, data);
  }

  updateDeviceType(id: number, data: Partial<Omit<AdminDeviceType, 'id'>>): Observable<AdminDeviceType> {
    return this.http.patch<AdminDeviceType>(`${this.base}/devices/${id}`, data);
  }

  deleteDeviceType(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/devices/${id}`);
  }

  // Actions
  getActions(deviceId: number): Observable<AdminDeviceAction[]> {
    return this.http.get<AdminDeviceAction[]>(`${this.base}/devices/${deviceId}/actions`);
  }

  createAction(deviceId: number, data: Omit<AdminDeviceAction, 'id' | 'device_id'>): Observable<AdminDeviceAction> {
    return this.http.post<AdminDeviceAction>(`${this.base}/devices/${deviceId}/actions`, data);
  }

  updateAction(actionId: number, data: Partial<Omit<AdminDeviceAction, 'id' | 'device_id'>>): Observable<AdminDeviceAction> {
    return this.http.patch<AdminDeviceAction>(`${this.base}/actions/${actionId}`, data);
  }

  deleteAction(actionId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/actions/${actionId}`);
  }
}
