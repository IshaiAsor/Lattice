import { Emitter } from '@socket.io/redis-emitter';
import { valkey } from '../cache/valkey';
import { SOCKET_EVENTS } from '@lattice/ioredis';

// The standalone socket-server (F2.7) holds the Valkey adapter, which synchronises rooms
// over Valkey pub/sub. This emitter publishes onto that same channel — so a worker with no
// Socket.IO server can still emit room events with sub-millisecond delivery and no extra
// consumer hop. See the plan for the RabbitMQ-vs-emitter rationale.
const emitter = new Emitter(valkey as never);

export const socket = {
  // Scalar readings AND camera frames both flow through this — the UI keys live updates by
  // action id (a camera frame is just the action's state as a base64 JPEG).
  emitActionStateUpdate(userId: number, userDeviceActionId: number, state: unknown, commandId?: string): void {
    emitter.to(`user_${userId}`).emit(SOCKET_EVENTS.ACTION_STATE_UPDATE, {
      actionId: userDeviceActionId,
      state,
      commandId,
    });
  },
  // A command was dispatched and is awaiting the device's ack. The UI shows the desired
  // value as pending until a confirming action_state_update (or a failed event) arrives.
  emitActionStatePending(userId: number, userDeviceActionId: number, commandId: string, state: unknown): void {
    emitter.to(`user_${userId}`).emit(SOCKET_EVENTS.ACTION_STATE_PENDING, {
      actionId: userDeviceActionId,
      commandId,
      state,
    });
  },
  // The device rejected the command or never acked within the timeout. The UI reverts the
  // pending toggle; no DB state was written.
  emitActionStateFailed(userId: number, userDeviceActionId: number, commandId: string,lastState?: unknown): void {
    emitter.to(`user_${userId}`).emit(SOCKET_EVENTS.ACTION_STATE_FAILED, {
      actionId: userDeviceActionId,
      commandId,
      lastState
    });
  },
  emitDeviceStatusChange(userId: number, userDeviceId: number, online: boolean): void {
    emitter.to(`user_${userId}`).emit(SOCKET_EVENTS.DEVICE_STATUS_CHANGE, {
      deviceId: userDeviceId,
      online,
    });
  },
};
