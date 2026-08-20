// backoffice/src/app/services/device-socket.service.ts
import { inject, Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
@Injectable({
  providedIn: 'root'
})
export class DeviceSocketService {
  private authService = inject(AuthService);
  private socket: Socket;

  readonly actionStateUpdate$: Observable<{ actionId: number, state: unknown, commandId?: string }>;
  readonly deviceOnlineStatusChange$: Observable<{ deviceId: number, online: boolean }>;
  readonly deviceUpdateState$: Observable<{ deviceId: number, status: 'confirmed' | 'failed', version: string | null, detail?: string }>;
  readonly actionStatePending$: Observable<{ actionId: number, commandId: string, state: unknown }>;
  readonly actionStateFailed$: Observable<{ actionId: number, commandId: string, lastState?: unknown }>;
  // A read-back verified the stored state was already right (F23). No state field — nothing
  // changed, only our confidence in it, so consumers refresh the freshness stamp and nothing else.
  readonly actionStateConfirmed$: Observable<{ actionId: number, confirmedAt: string }>;
  readonly pipelineRunUpdate$: Observable<{ runId: number, pipelineId: number, status: string, error?: string }>;
  readonly notification$: Observable<{ eventType: string, title: string, body: string, data?: unknown }>;

  constructor() {
    const socketUrl = environment.socketUrl ||
    (environment.production ? `${window.location.protocol}//socket.${window.location.hostname}` : '');
    this.socket = io(socketUrl, {
      auth: {
        token: this.authService.getToken()
      }
    });

    const socketEvent = <T>(event: string): Observable<T> =>
      new Observable<T>(obs => {
        const handler = (data: T) => obs.next(data);
        this.socket.on(event, handler);
        return () => { this.socket.off(event, handler); };
      });

    this.actionStateUpdate$ = socketEvent('action_state_update');
    this.deviceOnlineStatusChange$ = socketEvent('device_status_change');
    this.deviceUpdateState$ = socketEvent('device_update_state');
    this.actionStatePending$ = socketEvent('action_state_pending');
    this.actionStateFailed$ = socketEvent('action_state_failed');
    this.actionStateConfirmed$ = socketEvent('action_state_confirmed');
    this.pipelineRunUpdate$ = socketEvent('pipeline_run_update');
    this.notification$ = socketEvent('notification');
  }

  publishActionState(id: number, actionState: string) {
    console.log(`Publishing action state update for action ${id} with state ${actionState}`);
    this.socket.emit('action_state_update', { actionId: id, state: actionState });
  }

  onDeviceOnlineStatusChange(): Observable<{ deviceId: number, online: boolean }> {
    return this.deviceOnlineStatusChange$;
  }

  // A dispatched firmware update settled — 'confirmed' (device is running `version`) or
  // 'failed' (rolled back, `detail` is what the device reported). Releases the Update control,
  // which stays disabled from dispatch until this arrives.
  onDeviceUpdateState(): Observable<{ deviceId: number, status: 'confirmed' | 'failed', version: string | null, detail?: string }> {
    return this.deviceUpdateState$;
  }

  onActionStateUpdate(): Observable<{ actionId: number, state: unknown, commandId?: string }> {
    return this.actionStateUpdate$;
  }

  // A command was dispatched and is awaiting the device's ack. Confirmed state arrives
  // later via onActionStateUpdate; if the device never acks, onActionStateFailed fires.
  onActionStatePending(): Observable<{ actionId: number, commandId: string, state: unknown }> {
    return this.actionStatePending$;
  }

  // The device rejected the command or never acked within the timeout — no state changed.
  onActionStateFailed(): Observable<{ actionId: number, commandId: string, lastState?: unknown }> {
    return this.actionStateFailed$;
  }

  disconnect() {
    this.socket.disconnect();
  }
}
