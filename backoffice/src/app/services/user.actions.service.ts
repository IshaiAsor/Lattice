import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { apiUrl } from './api.config';
import { DeviceActionView, GoogleActionType, GoogleActionTrait } from './device.mgmt.service';

export interface ActionGroupView {
  id: number;
  name: string;
  previewTypes: (string | null)[];
  actions: DeviceActionView[];
}

export interface DashboardItem {
  kind: 'action' | 'group';
  sortOrder: number;
  action?: DeviceActionView;
  group?: ActionGroupView;
}

// Wire shape returned by the new `api` service GET /api/actions (F2.6).
interface ApiUserAction {
  id: number;
  deviceId: number;
  deviceName: string;
  name: string;
  mqttName: string;
  implementation_type: string;
  validParameters: unknown;
  googleTypeId: number | null;
  googleType: GoogleActionType | null;
  googleTraits: GoogleActionTrait[];
  defaultTraitId: number | null;
  state: unknown;
  online: boolean;
  lastOnlineDate: string | null;
  sortOrder: number;
  status: string;
  groupId: number | null;
  groupName: string | null;
  telemetryIntervalMs: number | null;
}

@Injectable({
  providedIn: 'root',
})
export class UserActionsService {
  private apiUrl = apiUrl();

  http = inject(HttpClient);

  getUserActions(): Observable<DeviceActionView[]> {
    return this.http
      .get<ApiUserAction[]>(`${this.apiUrl}/api/actions`)
      .pipe(map((rows) => rows.map((r) => this.toView(r))));
  }

  // Maps the new api action shape onto the UI's DeviceActionView. Pins are not part of
  // the actions surface (they belong to device-config), so they default to [].
  private toView(r: ApiUserAction): DeviceActionView {
    return {
      id: r.id,
      name: r.name,
      deviceName: r.deviceName,
      type: r.googleType?.name ?? '',
      googleTraits: r.googleTraits,
      defaultTraitId: r.defaultTraitId,
      state: r.state,
      deviceId: r.deviceId,
      googleType: r.googleType,
      online: r.online,
      lastOnlineDate: r.lastOnlineDate ? new Date(r.lastOnlineDate) : null,
      pins: [],
      sortOrder: r.sortOrder,
      groupId: r.groupId,
      groupName: r.groupName,
      implementation_type: r.implementation_type,
      validParameters: r.validParameters,
      status: r.status === 'active' ? 'active' : 'deprecated',
    };
  }

  updateUserAction(action: DeviceActionView) {
    return this.http.patch<void>(`${this.apiUrl}/api/actions/${action.id}`, {
      name: action.name,
    });
  }

  reorderActions(orderedIds: number[]) {
    return this.http.put<void>(`${this.apiUrl}/api/actions/order`, { orderedIds });
  }

  assignActionsToGroup(name: string, actionIds: number[]): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.apiUrl}/api/action-groups/assign`, { name, actionIds });
  }

  removeActionFromGroup(actionId: number): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/api/actions/${actionId}`, { group_id: null });
  }

  // Renames a group in place (all actions stay in the same group).
  renameGroup(groupId: number, newName: string): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/api/action-groups/${groupId}`, { name: newName });
  }

  // Deletes a group; the backend SET NULLs all actions' group_id automatically.
  deleteGroup(groupId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/action-groups/${groupId}`);
  }

  deleteAction(actionId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/actions/${actionId}`);
  }

  setDefaultTrait(actionId: number, traitId: number): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/api/actions/${actionId}`, { default_trait_id: traitId });
  }
}
