import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';
import { apiUrl } from './api.config';
export interface GoogleActionType { id: number; name: string; value: string; }
export interface GoogleActionTrait {
  id: number;
  name: string;
  value: string;
}

@Injectable({
  providedIn: 'root'
})
export class DeviceMgmtService {
  private apiUrl = apiUrl();
  private get gatewayUrl(): string {
    return environment.deviceGatewayUrl ||
      (environment.production ? `${window.location.protocol}//device.${window.location.hostname}` : 'http://localhost:3004');
  }
  private http = inject(HttpClient);

  getDevices(): Observable<DeviceView[]> {
    return this.http.get<DeviceView[]>(`${this.apiUrl}/api/devices`);
  }

  updateDevice(deviceId: number, updates: unknown): Observable<DeviceView> {
    return this.http.patch<DeviceView>(`${this.apiUrl}/api/devices/${deviceId}`, updates);
  }

  deleteDevice(deviceId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/devices/${deviceId}`);
  }

  reprovisionDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/devices/${deviceId}/reprovision`, {});
  }

  softResetDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/devices/${deviceId}/soft-reset`, {});
  }

  hardResetDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/devices/${deviceId}/hard-reset`, {});
  }

  restartDevice(deviceId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/api/devices/${deviceId}/restart`, {});
  }

  getUpdatePreview(deviceId: number): Observable<UpdatePreview | { up_to_date: true }> {
    return this.http.get<UpdatePreview | { up_to_date: true }>(`${this.gatewayUrl}/api/devices/${deviceId}/update-preview`);
  }

  applyUpdate(deviceId: number): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.gatewayUrl}/api/devices/${deviceId}/apply-update`, {});
  }

  getDeviceCapabilities(deviceId: number): Observable<CapabilityView[]> {
    return this.http.get<CapabilityView[]>(`${this.apiUrl}/api/devices/${deviceId}/capabilities`);
  }

  activateCapability(
    deviceId: number,
    capabilityId: number,
    telemetryIntervalMs?: number | null,
    pins?: { capability_pin_id: number; pin_number: number }[],
    cameraResolution?: string | null,
    cameraTransport?: string | null,
  ): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.apiUrl}/api/devices/${deviceId}/actions`, {
      capability_id: capabilityId,
      telemetry_interval_ms: telemetryIntervalMs ?? null,
      pins: pins ?? [],
      camera_resolution: cameraResolution ?? null,
      camera_transport: cameraTransport ?? null,
    });
  }

  updateActivatedAction(
    deviceId: number,
    userActionId: number,
    updates: {
      name: string; telemetry_interval_ms?: number | null; pins?: { capability_pin_id: number; pin_number: number }[];
      camera_resolution?: string | null; camera_transport?: string | null;
    },
  ): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/api/devices/${deviceId}/actions/${userActionId}`, updates);
  }
}

export interface PinSlot {
  id: number;
  key: string;
  label: string;
  mode: string;
  description?: string;
}

export interface UserActionView {
  id: number;
  name: string;
  mqttName: string;
  pins: { pinNumber: number; pinMode: string }[] | null;
  intervalMs: number | null;
  status: 'active' | 'deprecated';
  // CameraAction only — null for every other implementation_type.
  cameraResolution: string | null;
  cameraTransport: string | null;
}

export interface CapabilityView {
  id: number;
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  min_telemetry_interval_ms: number | null;
  configurable_pins: PinSlot[];
  instances: UserActionView[];
}

export interface DeviceView {
  id: number;
  deviceName: string;
  online: boolean;
  lastOnlineDate: Date;
  type: string;
  version: string;
  current_firmware_version: string | null;
  update_available: boolean;
}

export interface ActionPreview {
  id: number;
  name: string;
  mqttName: string;
  status: 'ok' | 'deprecated';
  reason?: string;
}

export interface UpdatePreview {
  current_version: string;
  new_version: string;
  actions: ActionPreview[];
}

export interface DeviceActionView {
  id: number;
  name: string;
  deviceName: string;
  type: string;
  googleTraits: GoogleActionTrait[];
  defaultTraitId: number | null;
  state: unknown;
  deviceId: number;
  googleType: GoogleActionType | null;
  online: boolean;
  lastOnlineDate?: Date | null;
  pins: DeviceActionPinView[];
  sortOrder: number;
  groupId: number | null;
  groupName: string | null;
  implementation_type: string;
  // Firmware-authored accepted-value constraint ({type:'enum'|'range'|'pattern', ...}), or
  // undefined when not fetched via UserActionsService (e.g. device-config's own action list).
  validParameters?: unknown;
  // Transient UI flag: a command was sent and is awaiting the device's ack. Set on
  // action_state_pending, cleared on action_state_update / action_state_failed. Not persisted.
  pending?: boolean;
  status: 'active' | 'deprecated';
  // Client-side wall-clock time (ms since epoch) this browser tab received the current `state`
  // via action_state_update. Local only — never persisted or sent by the server.
  receivedAt?: number;
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
