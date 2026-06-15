import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';
import { GoogleActionType } from './google.actions.types.service';
import { GoogleActionTrait } from './google.actions.traits.service';

@Injectable({
  providedIn: 'root'
})
export class DeviceMgmtService {
  private apiUrl = `${environment.apiUrl}`;
  private http = inject(HttpClient);

  getDevices(): Observable<DeviceView[]> {
    return this.http.get<DeviceView[]>(`${this.apiUrl}/api/mgmt/devices`);
  }

  addDevice(deviceData: unknown): Observable<DeviceView> {
    return this.http.post<DeviceView>(`${this.apiUrl}/api/mgmt/devices`, deviceData);
  }

  updateDeviceStatus(deviceId: number, status: number): Observable<DeviceView> {
    return this.http.patch<DeviceView>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/status`, { status });
  }

  updateDevice(deviceId: number, updates: unknown): Observable<DeviceView> {
    return this.http.patch<DeviceView>(`${this.apiUrl}/api/mgmt/devices/${deviceId}`, updates);
  }

  deleteDevice(deviceId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}`);
  }

  reprovisionDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/reprovision`, {});
  }

  softResetDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/soft-reset`, {});
  }

  hardResetDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/hard-reset`, {});
  }

  restartDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/restart`, {});
  }

  getDeviceBlueprints(deviceId: number): Observable<BlueprintView[]> {
    return this.http.get<BlueprintView[]>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/blueprints`);
  }

  activateBlueprint(
    deviceId: number,
    blueprintId: number,
    telemetryIntervalMs?: number | null,
    pins?: { pinNumber: number; pinMode: string }[],
  ): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/actions/from-blueprint`, {
      blueprintId,
      telemetry_interval_ms: telemetryIntervalMs ?? null,
      pins: pins ?? null,
    });
  }

  updateActivatedAction(
    deviceId: number,
    userActionId: number,
    updates: { name: string; telemetry_interval_ms?: number | null; pins?: { pinNumber: number; pinMode: string }[] },
  ): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/actions/${userActionId}`, updates);
  }
}

export interface PinSlot {
  key: string;
  label: string;
  mode: string;
  description?: string;
}

export interface BlueprintInstanceView {
  id: number;
  name: string;
  mqttName: string;
  pins: { pinNumber: number; pinMode: string }[] | null;
  intervalMs: number | null;
}

export interface BlueprintView {
  id: number;
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  min_telemetry_interval_ms: number | null;
  configurable_pins: PinSlot[];
  instances: BlueprintInstanceView[];
}

export interface DeviceView {
  id: number;
  deviceName: string;
  status: number;
  online: boolean;
  lastOnlineDate: Date;
  type: string;
  version: string;
}

export interface DeviceActionView {
  id: number;
  name: string;
  deviceName: string;
  type: string;
  googleTraits: GoogleActionTrait[];
  state: unknown;
  deviceId: number;
  googleType: GoogleActionType | null;
  online: boolean;
  pins: DeviceActionPinView[];
  sortOrder: number;
  groupName: string | null;
  implementation_type: string;
}

export interface DeviceActionPinView {
  id: number;
  actionId: number;
  deviceId: number;
  pinNumber: number;
  pinMode: number;
  pinType: number;
  currentValue: string;
  device?: DeviceView;
}
