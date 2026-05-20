import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import { DeviceActionView } from './device.mgmt.service';

@Injectable({
  providedIn: 'root',
})
export class UserActionsService {
  private apiUrl = `${environment.apiUrl}`;

  constructor() {}

  http = inject(HttpClient);
  getUserActions() {
    return this.http.get<DeviceActionView[]>(`${this.apiUrl}/api/mgmt/actions`);
  }

  addUserAction(action: DeviceActionView) {
    return this.http.post<DeviceActionView>(`${this.apiUrl}/api/mgmt/actions`, action);
  }

  updateUserAction(action: DeviceActionView) {
    return this.http.patch<DeviceActionView>(
      `${this.apiUrl}/api/mgmt/actions/${action.id}`,
      action,
    );
  }

  delete(action: DeviceActionView) {
    return this.http.delete<void>(`${this.apiUrl}/api/mgmt/actions/${action.id}`);
  }
}
