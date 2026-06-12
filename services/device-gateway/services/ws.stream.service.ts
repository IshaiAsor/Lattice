import { deviceCache } from '../dal/device.cache';
import { socketEmitter } from './socket.emitter.service';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway:camera');

// Camera pipeline trigger tracking: minimum interval between triggers (ms)
const PIPELINE_COOLDOWN_MS = 30_000;
const lastTriggerAt = new Map<number, number>(); // userDeviceId → timestamp

export async function processCameraFrame(
  userId: number,
  userDeviceId: number,
  userActionId: number,
  frame: string,
  pipelineId?: number,
): Promise<void> {
  // Store frame in Valkey for WebSocket stream relay and pipeline consumption
  await deviceCache.storeFrame(userDeviceId, frame);

  // Emit frame to Angular via the api's Socket.IO
  socketEmitter.emitCameraFrame(userId, userDeviceId, frame);

  // Trigger pipeline if configured and cooldown has elapsed
  if (!pipelineId) return;

  const now = Date.now();
  const last = lastTriggerAt.get(userDeviceId) ?? 0;
  if (now - last < PIPELINE_COOLDOWN_MS) return;

  lastTriggerAt.set(userDeviceId, now);
  log.info({ userId, userDeviceId, pipelineId }, 'Triggering pipeline from camera frame');

  await publish(RK.pipelineTrigger(userId), {
    userId,
    pipelineId,
    triggerUserActionId: userActionId,
  }).catch((err) => log.error(err, 'Failed to publish pipeline.trigger'));
}
