import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import { DeviceActionView } from './device.mgmt.service';

export interface ActionGroupView {
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

@Injectable({
  providedIn: 'root',
})
export class UserActionsService {
  private apiUrl = `${environment.apiUrl}`;

  http = inject(HttpClient);

  getUserActions() {
    return this.http.get<DeviceActionView[]>(`${this.apiUrl}/api/mgmt/actions`);
  }

  updateUserAction(action: DeviceActionView) {
    return this.http.patch<DeviceActionView>(
      `${this.apiUrl}/api/mgmt/actions/${action.id}`,
      action,
    );
  }

  reorderActions(orderedIds: number[]) {
    return this.http.put<void>(`${this.apiUrl}/api/mgmt/actions/order`, { orderedIds });
  }

  setActionGroup(actionId: number, groupName: string | null) {
    return this.http.patch<void>(`${this.apiUrl}/api/mgmt/actions/${actionId}`, {
      group_name: groupName,
    });
  }
}
