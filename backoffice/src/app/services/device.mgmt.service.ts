import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';
import { GoogleActionType } from './google.actions.types.service';

@Injectable({
  providedIn: 'root'
})
export class DeviceMgmtService {
  private apiUrl = `${environment.apiUrl}`;

  constructor(private http: HttpClient) { }

  getDevices(): Observable<DeviceView[]> {
    return this.http.get<DeviceView[]>(`${this.apiUrl}/api/mgmt/devices`);
  }

  addDevice(deviceData: any): Observable<DeviceView> {
    return this.http.post<DeviceView>(`${this.apiUrl}/api/mgmt/devices`, deviceData);
  }

  updateDeviceStatus(deviceId: number, status: number): Observable<DeviceView> {
    return this.http.patch<DeviceView>(`${this.apiUrl}/api/mgmt/devices/${deviceId}/status`, { status });
  }

  updateDevice(deviceId: number, updates: any): Observable<DeviceView> {
    return this.http.patch<DeviceView>(`${this.apiUrl}/api/mgmt/devices/${deviceId}`, updates);
  }

  deleteDevice(deviceId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/api/mgmt/devices/${deviceId}`);
  }
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
  type: string;
  trait: string;
  state: any;
  deviceId: number;
  googleType: any;
  online:boolean;
  pins: DeviceActionPinView[];
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


