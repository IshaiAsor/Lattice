import type { Channel } from 'amqplib';
import type { TelemetryArrivedPayload, PictureResultPayload } from '@lattice/queue';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { resolveUserDeviceAction } from '../resolve';
import { asString } from '../util';
import { socket } from '../socket/emitter';
import { writeScalarState } from '../state-write';
import { takePendingPicture } from '../cache/pending';
import { recordCaptureArrived } from '../command-history';
import * as timeout from '../pending-timeout';
import { isErrorReading, type ErrorReading } from '@lattice/params';

const log = createLogger('digest-service:telemetry');

// Latest-frame cache TTL — covers live relay / pipeline pickup, not history.
const CAMERA_FRAME_TTL_SECONDS = 60;

export function telemetryConsumer(ch: Channel) {
  return async (payload: TelemetryArrivedPayload): Promise<void> => {
    const { userId, deviceId, actionName, timestamp } = payload;

    // payload.value can be a base64 image frame — never log it raw here, before the kind
    // (scalar vs image) is known. handleScalar/handleImage log their own specifics.
    log.info({ userId, deviceId, actionName, timestamp }, 'telemetry received');

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
      await handleImage(ch, resolved.id, payload);
      return;
    }
    await handleScalar(ch, resolved.id, payload);
  };
}

// Camera-frame telemetry. Every frame is persisted to sensor_history (the value column
// is TEXT) — full image history is intentional; retention/cleanup is a roadmap item.
// The frame never goes to current_state or rules.evaluate.
async function handleImage(
  ch: Channel,
  userActionId: number,
  payload: TelemetryArrivedPayload,
): Promise<void> {
  const { userId, deviceId, value, timestamp, commandId } = payload;
  const userDeviceId = parseInt(deviceId, 10);
  const frame = asString(value);

  // 1. Authoritative history write — failure nacks → DLQ.
  await db.sensorHistory.create({
    data: {
      user_device_action_id: userActionId,
      value: frame,
      recorded_at: new Date(timestamp),
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

  // 4. If this frame answers an in-flight on-demand capture (a pipeline enrich stage, or a user
  // asking from the camera card), resolve it. takePendingPicture is the arbiter against the
  // request's own timeout — whichever fires first wins, so this is a no-op if the timeout already
  // resolved it, and the history row keeps the timeout verdict a late frame does not undo.
  if (commandId) {
    timeout.clear(commandId);
    try {
      const pending = await takePendingPicture(commandId);
      if (pending !== null) {
        // Settled by size, never by value — the frame is a base64 JPEG and the column is 255 chars.
        await recordCaptureArrived(commandId, Buffer.byteLength(frame, 'base64'));
        if (pending.deliverResult ?? true) {
          const result: PictureResultPayload = {
            commandId,
            status: 'ok',
            image: frame,
            capturedAt: timestamp,
          };
          publish(ch, RK.PICTURE_RESULT, result);
        }
      }
    } catch (err) {
      log.error({ err, commandId }, 'picture request resolution failed');
    }
  }

  // Never log `frame` itself — it's a base64 JPEG, easily hundreds of KB.
  log.info(
    { userDeviceId, userActionId, frameSizeBytes: frame.length, commandId },
    'camera frame stored',
  );
}

// Scalar sensor reading. Delegates to the shared authoritative-state writer (also used
// by the action-result/ack path) — state write is authoritative, the rest best-effort.
// Pipeline sensor-threshold matching is NOT done here: automation-worker consumes the same
// telemetry.arrived stream (its own queue) and owns all trigger matching.
async function handleScalar(
  ch: Channel,
  userActionId: number,
  payload: TelemetryArrivedPayload,
): Promise<void> {
  const { userId, deviceId, actionName, value, timestamp } = payload;

  // Fault reading: record it to history (timestamped, so error *duration* is queryable —
  // the basis for the roadmapped sensor_error_duration trigger) but never touch current_state.
  // The last good value stays authoritative.
  if (isErrorReading(value)) {
    await recordErrorReading(userActionId, value, timestamp);
    return;
  }

  await writeScalarState(ch, userActionId, {
    userId,
    deviceId,
    actionName,
    value,
    timestamp,
    source: 'telemetry',
  });
}

// A fault reading is persisted to sensor_history as a structured error row (value NULL,
// is_error true, error_code = the fault envelope's code) and nowhere else — the fault never
// touches current_state or value thresholds. The history write is authoritative — a throw
// nacks → DLQ. Keeping faults out of the value column keeps the numeric series clean and makes
// the roadmapped sensor_error_duration trigger a simple `WHERE is_error = true` query.
async function recordErrorReading(
  userActionId: number,
  reading: ErrorReading,
  timestamp: string,
): Promise<void> {
  log.warn(
    { userActionId, errorCode: reading.error },
    'fault telemetry reading — recording to history only',
  );
  await db.sensorHistory.create({
    data: {
      user_device_action_id: userActionId,
      value: null,
      is_error: true,
      error_code: reading.error.slice(0, 100),
      recorded_at: new Date(timestamp),
    },
  });
}
