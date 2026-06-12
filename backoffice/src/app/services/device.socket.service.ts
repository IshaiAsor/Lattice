import { inject, Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import type {
  ActionStateUpdateEvent,
  DeviceStatusChangeEvent,
  EmergencyAlertEvent,
  PipelineResultEvent,
} from '../models';

export interface CameraFrameEvent {
  deviceId: number;
  frame: string;
}

export interface ActionDispatch {
  actionId:     number;
  userDeviceId: number;
  mqttType:     string;
  mqttName:     string;
  state:        string;
}

@Injectable({ providedIn: 'root' })
export class DeviceSocketService {
  private authService = inject(AuthService);
  private socket: Socket;

  // ── Typed subjects for in-app subscriptions ───────────────────────────────
  private deviceStatus$   = new Subject<DeviceStatusChangeEvent>();
  private actionState$    = new Subject<ActionStateUpdateEvent>();
  private emergencyAlert$ = new Subject<EmergencyAlertEvent>();
  private pipelineResult$ = new Subject<PipelineResultEvent>();
  private vlmError$       = new Subject<unknown>();
  private cameraFrame$    = new Subject<CameraFrameEvent>();

  onDeviceStatusChange()  { return this.deviceStatus$.asObservable(); }
  onActionStateUpdate()   { return this.actionState$.asObservable(); }
  onEmergencyAlert()      { return this.emergencyAlert$.asObservable(); }
  onPipelineResult()      { return this.pipelineResult$.asObservable(); }
  onVlmError()            { return this.vlmError$.asObservable(); }
  onCameraFrame()         { return this.cameraFrame$.asObservable(); }

  constructor() {
    this.socket = io(environment.apiUrl, {
      auth: { token: this.authService.getToken() },
    });

    this.socket.on('device_status_change', (d: DeviceStatusChangeEvent) => this.deviceStatus$.next(d));
    this.socket.on('action_state_update',  (d: ActionStateUpdateEvent)  => this.actionState$.next(d));
    this.socket.on('emergency_alert',      (d: EmergencyAlertEvent)     => this.emergencyAlert$.next(d));
    this.socket.on('pipeline_result',      (d: PipelineResultEvent)     => this.pipelineResult$.next(d));
    this.socket.on('vlm_error',            (d: unknown)                 => this.vlmError$.next(d));
    this.socket.on('camera_frame',         (d: CameraFrameEvent)        => this.cameraFrame$.next(d));
  }

  /** Dispatch a device action command via Socket.IO → api → RabbitMQ → device-gateway → EMQX */
  dispatchAction(payload: ActionDispatch): void {
    this.socket.emit('action_state_update', payload);
  }

  disconnect(): void { this.socket.disconnect(); }
}
