import { Emitter } from '@socket.io/redis-emitter';
import { valkey } from './valkey';

// Single emitter instance — same Valkey pubsub channel as api's Socket.IO adapter
const emitter = new Emitter(valkey);

export function emitActionStateUpdate(userId: number, actionId: number, state: string): void {
  emitter.to(`user_${userId}`).emit('action_state_update', { actionId, state });
}

export function emitDeviceStatusChange(userId: number, deviceId: number, online: boolean): void {
  emitter.to(`user_${userId}`).emit('device_status_change', { deviceId, online });
}

export function emitPipelineResult(userId: number, payload: object): void {
  emitter.to(`user_${userId}`).emit('pipeline_result', payload);
}
