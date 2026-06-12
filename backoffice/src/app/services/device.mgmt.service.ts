import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import type { UserAction, UserActionDef, UserDevice } from '../models';

export interface ActivateCapabilityInput {
  user_action_def_id: number;
  name: string;
  user_action_group_id?: number | null;
}

@Injectable({ providedIn: 'root' })
export class DeviceMgmtService {
  private readonly apiUrl = environment.apiUrl;
  private http = inject(HttpClient);

  getDevices()                                     { return this.http.get<UserDevice[]>(`${this.apiUrl}/api/mgmt/devices`); }
  getDevice(id: number)                            { return this.http.get<UserDevice>(`${this.apiUrl}/api/mgmt/devices/${id}`); }
  getPendingDefs(deviceId: number)                 { return this.http.get<UserActionDef[]>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/pending-defs`); }
  activateCapabilities(deviceId: number, items: ActivateCapabilityInput[]) {
    return this.http.post<{ activated: UserAction[] }>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/activate`, items);
  }
  renameDevice(id: number, name: string)           { return this.http.patch<UserDevice>(`${this.apiUrl}/api/mgmt/devices/${id}`, { name }); }
  deleteDevice(id: number)                         { return this.http.delete<void>(`${this.apiUrl}/api/mgmt/devices/${id}`); }
  reprovisionDevice(id: number)                    { return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${id}/reprovision`, {}); }
  softResetDevice(id: number)                      { return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${id}/soft-reset`, {}); }
  hardResetDevice(id: number)                      { return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${id}/hard-reset`, {}); }
  restartDevice(id: number)                        { return this.http.post<void>(`${this.apiUrl}/api/mgmt/devices/${id}/restart`, {}); }
}
