// backoffice/src/app/services/device-socket.service.ts
import { Injectable } from '@angular/core';
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
  private socket: Socket;

  constructor(private authService: AuthService) {
    this.socket = io(environment.apiUrl, {
      auth: {
        token: this.authService.getToken()
      }
    });
  }

  onDeviceOnlineStatusChange(): Observable<any> {
    return new Observable((observer) => {
      this.socket.on('device_status_change', (data) => {
        observer.next(data);
      });
    });
  }

  onActionStateUpdate(): Observable<{ actionId: number, state: any }> {
    return new Observable((observer) => {
      this.socket.on('action_state_update', (data) => {
        observer.next(data);
      });
    });
  }

  disconnect() {
    this.socket.disconnect();
  }
}
