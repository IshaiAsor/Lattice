// backoffice/src/app/services/device-socket.service.ts
import { inject, Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, Subject } from 'rxjs';
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
  // Fires on every connection AFTER the first, i.e. the socket was away and is back. Nothing
  // replays what was emitted in the gap, so whoever holds state must refetch it here or keep
  // rendering values the platform has moved past.
  readonly reconnected$: Observable<void>;

  private reconnected = new Subject<void>();
  private hasConnected = false;
  // The token the last handshake actually carried, and whether a refresh is already in flight for
  // a rejected one. Together they stop the recovery below from looping.
  private presentedToken: string | null = null;
  private refreshingAuth = false;

  constructor() {
    const socketUrl = environment.socketUrl ||
    (environment.production ? `${window.location.protocol}//socket.${window.location.hostname}` : '');
    this.socket = io(socketUrl, {
      // A function, not an object: socket.io re-invokes it on every (re)connection attempt, so the
      // handshake always carries the token that is current now. Read once into an object literal
      // it froze at whatever storage held when this service was constructed — and a later sign-in
      // or token refresh replaced that token, so the next reconnect presented a dead one and the
      // server's JWT middleware rejected it. That rejection is terminal (see connect_error), so
      // the socket never came back and the UI silently stopped receiving state until a reload.
      auth: (cb: (data: object) => void) => {
        this.presentedToken = this.authService.getToken();
        cb({ token: this.presentedToken ?? '' });
      }
    });

    this.socket.on('connect', () => {
      if (this.hasConnected) this.reconnected.next();
      this.hasConnected = true;
      this.refreshingAuth = false;
    });
    this.reconnected$ = this.reconnected.asObservable();

    // `active` is false only when the server itself refused the handshake — socket.io retries
    // transport failures on its own but never a middleware rejection, so without this a single
    // expired token ends live updates for the life of the tab. The two recoverable causes are a
    // token that storage has already replaced (sign-in elsewhere in the app) and one that merely
    // expired; anything else is a real auth failure and the interceptor owns the redirect.
    this.socket.on('connect_error', () => {
      if (this.socket.active) return;
      const current = this.authService.getToken();
      if (current && current !== this.presentedToken) {
        this.socket.connect();
        return;
      }
      if (this.refreshingAuth) return;
      this.refreshingAuth = true;
      this.authService.refreshAccessToken().subscribe({
        // refreshingAuth is cleared on 'connect', not here: if the fresh token is rejected too,
        // retrying would spin a refresh round-trip per attempt.
        next: () => this.socket.connect(),
        error: () => { this.refreshingAuth = false; },
      });
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
