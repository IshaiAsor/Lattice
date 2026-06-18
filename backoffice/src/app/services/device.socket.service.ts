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
  publishActionState(id: number, actionState: string) {
    console.log(`Publishing action state update for action ${id} with state ${actionState}`);
    this.socket.emit('action_state_update', { actionId: id, state: actionState });
  }
  private authService = inject(AuthService);
  private socket: Socket;

  constructor() {
    const socketUrl = environment.socketUrl ||
      (environment.production ? `${window.location.protocol}//socket.${window.location.hostname}` : '');
    this.socket = io(socketUrl, {
      auth: {
        token: this.authService.getToken()
      }
    });
  }

  onDeviceOnlineStatusChange(): Observable<{ deviceId: number, online: boolean }> {
    return new Observable((observer) => {
      this.socket.on('device_status_change', (data) => {
        observer.next(data);
      });
    });
  }

  onActionStateUpdate(): Observable<{ actionId: number, state: unknown, commandId?: string }> {
    return new Observable((observer) => {
      this.socket.on('action_state_update', (data) => {
        observer.next(data);
      });
    });
  }

  // A command was dispatched and is awaiting the device's ack. Confirmed state arrives
  // later via onActionStateUpdate; if the device never acks, onActionStateFailed fires.
  onActionStatePending(): Observable<{ actionId: number, commandId: string, state: unknown }> {
    return new Observable((observer) => {
      this.socket.on('action_state_pending', (data) => {
        observer.next(data);
      });
    });
  }

  // The device rejected the command or never acked within the timeout — no state changed.
  onActionStateFailed(): Observable<{ actionId: number, commandId: string ,lastState?: unknown }> {
    return new Observable((observer) => {
      this.socket.on('action_state_failed', (data) => {
        observer.next(data);
      });
    });
  }

  disconnect() {
    this.socket.disconnect();
  }
}
