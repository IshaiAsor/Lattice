import { Emitter } from '@socket.io/redis-emitter';
import IORedis from 'ioredis';
import config from '../config/env.config';

// Uses the same Valkey instance as the api's Socket.IO Redis adapter.
// Events emitted here are delivered by the api to connected Angular clients.
class SocketEmitterService {
  private emitter: Emitter;

  constructor() {
    const client = new IORedis(config.valkey.url, {
      username: config.valkey.username,
      password: config.valkey.password,
      lazyConnect: true,
    });
    this.emitter = new Emitter(client);
  }

  emitActionStateUpdate(userId: number, actionId: number, state: string): void {
    this.emitter.to(`user_${userId}`).emit('action_state_update', { actionId, state });
  }

  emitDeviceStatusChange(userId: number, deviceId: number, online: boolean): void {
    this.emitter.to(`user_${userId}`).emit('device_status_change', { deviceId, online });
  }

  emitEmergencyAlert(userId: number, payload: object): void {
    this.emitter.to(`user_${userId}`).emit('emergency_alert', payload);
  }

  emitCameraFrame(userId: number, deviceId: number, frame: string): void {
    this.emitter.to(`user_${userId}`).emit('camera_frame', { deviceId, frame });
  }
}

export const socketEmitter = new SocketEmitterService();
