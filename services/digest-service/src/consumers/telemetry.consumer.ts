import type { Channel } from 'amqplib';
import type { TelemetryArrivedPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { resolveUserDeviceAction } from '../resolve';
import { asString } from '../util';
import { socket } from '../socket/emitter';
import { writeScalarState } from '../state-write';

const log = createLogger('digest-service:telemetry');

// Latest-frame cache TTL — covers live relay / pipeline pickup, not history.
const CAMERA_FRAME_TTL_SECONDS = 60;

export function telemetryConsumer(ch: Channel) {
  return async (payload: TelemetryArrivedPayload): Promise<void> => {
    const { userId, deviceId, actionName, value, timestamp } = payload;

    log.trace({ userId, deviceId, actionName, value, timestamp }, 'telemetry received');

    // Resolve to the UserDeviceAction id + kind (Valkey cache → DB join fallback).
    const resolved = await resolveUserDeviceAction(deviceId, actionName);

    if (resolved === null) {
      // Unknown device/action — not a transient error. Throw so the message is
      // nacked → DLQ (via @lattice/queue's consume wrapper), making the failure
      // visible and re-publishable after the provisioning gap is fixed. Common
      // cause: telemetry arrived before provisioning completed, or action deleted.
      log.error({ userId, deviceId, actionName }, 'unresolved telemetry action → DLQ');
      throw new Error(`unresolved action ${deviceId}/${actionName}`);
    }

    if (resolved.kind === 'image') {
      await handleImage(resolved.id, payload);
      return;
    }
    await handleScalar(ch, resolved.id, payload);
  };
}

// Camera-frame telemetry. Every frame is persisted to sensor_history (the value column
// is TEXT) — full image history is intentional; retention/cleanup is a roadmap item.
// The frame never goes to current_state or rules.evaluate.
async function handleImage(
  userActionId: number,
  payload: TelemetryArrivedPayload,
): Promise<void> {
  const { userId, deviceId, value, timestamp } = payload;
  const userDeviceId = parseInt(deviceId, 10);
  const frame = asString(value);

  // 1. Authoritative history write — failure nacks → DLQ.
  await db.sensorHistory.create({
    data: {
      user_device_action_id: userActionId,
      value:                 frame,
      recorded_at:           new Date(timestamp),
    },
  });

  // 2. Cache latest frame for live relay / pipeline pickup (best-effort).
  try {
    await valkey.set(keys.cameraFrame(userDeviceId), frame, 'EX', CAMERA_FRAME_TTL_SECONDS);
  } catch (err) {
    log.error({ err, userDeviceId }, 'valkey camera_frame set failed');
  }

  // 3. Push the frame to the UI as an action_state_update keyed by the action id — the
  // UI binds the camera display to a specific action and renders action.state, so frames
  // must be addressed per-action (not per-device). Matches the legacy contract; current_state
  // is intentionally NOT written for images (every frame would churn the DB).
  try {
    socket.emitActionStateUpdate(parseInt(userId, 10), userActionId, frame);
  } catch (err) {
    log.error({ err, userActionId }, 'socket image frame emit failed');
  }

  // TODO(F8): trigger a configured pipeline (RK.PIPELINE_TRIGGER) with a per-device
  // cooldown once the Pipeline model lands. The cached frame above feeds VLM/LLM stages.
}

// Scalar sensor reading. Delegates to the shared authoritative-state writer (also used
// by the action-result/ack path) — state write is authoritative, the rest best-effort.
async function handleScalar(
  ch: Channel,
  userActionId: number,
  payload: TelemetryArrivedPayload,
): Promise<void> {
  const { userId, deviceId, actionName, value, timestamp } = payload;
  await writeScalarState(ch, userActionId, { userId, deviceId, actionName, value, timestamp });
}
