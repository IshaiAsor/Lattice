import IORedis from 'ioredis';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';

const log = createLogger('digest-service:valkey');

export const valkey = new IORedis(env.valkey.url, {
  username: env.valkey.username,
  password: env.valkey.password,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

valkey.on('error', (err) => log.error({ err }, 'valkey connection error'));

export const keys = {
  // Hot state — written after every confirmed telemetry DB write.
  actionState: (userDeviceActionId: number) => `action_state:${userDeviceActionId}`,
  // Device liveness — set with a heartbeat-length TTL on online, deleted on offline.
  deviceOnline: (userDeviceId: number) => `device_online:${userDeviceId}`,
  // Latest camera frame for live relay / pipeline consumption (short TTL).
  cameraFrame: (userDeviceId: number) => `camera_frame:${userDeviceId}`,
  // Resolution cache: (deviceId string, actionName) → "{id}:{kind}".
  actionResolve: (deviceId: string, actionName: string) =>
    `action_resolve:${deviceId}:${actionName}`,
  // In-flight command awaiting a device ack. Holds the request context so the ack /
  // timeout can resolve it. TTL-backed so it self-clears if the process dies.
  pendingCommand: (commandId: string) => `pending_command:${commandId}`,
  // In-flight on-demand picture capture awaiting the device's uploaded frame.
  pendingPicture: (commandId: string) => `pending_picture:${commandId}`,
};

// Whether a telemetry value is a scalar sensor reading or an image/camera frame.
// Drives DB routing in the telemetry consumer.
export type ActionKind = 'scalar' | 'image';

export interface ResolvedAction {
  id: number;
  kind: ActionKind;
}

// Resolves a (deviceId, actionName) pair to the UserDeviceAction id and its kind.
// Caches the mapping for 5 min to avoid a DB round-trip on every telemetry message;
// actions are reconfigured infrequently. A null result is NOT cached — an unknown
// pair usually means a provisioning race that will resolve shortly.
export async function resolveAction(
  deviceId: string,
  actionName: string,
  fallback: () => Promise<ResolvedAction | null>,
): Promise<ResolvedAction | null> {
  const key = keys.actionResolve(deviceId, actionName);
  const cached = await valkey.get(key);
  if (cached !== null) {
    const [idStr, kind] = cached.split(':');
    return { id: parseInt(idStr, 10), kind: kind === 'image' ? 'image' : 'scalar' };
  }

  const resolved = await fallback();
  if (resolved !== null) {
    await valkey.set(key, `${resolved.id}:${resolved.kind}`, 'EX', 300);
  }
  return resolved;
}
