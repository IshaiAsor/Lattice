import type { Channel } from 'amqplib';
import type { TelemetryArrivedPayload, PictureResultPayload } from '@lattice/queue';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db, Prisma } from '../db/client';
import { valkey, keys } from '../cache/valkey';
import { resolveUserDeviceAction } from '../resolve';
import { asString } from '../util';
import { socket } from '../socket/emitter';
import { writeScalarState } from '../state-write';
import { takePendingPicture } from '../cache/pending';
import * as timeout from '../pending-timeout';

const log = createLogger('digest-service:telemetry');

// Latest-frame cache TTL — covers live relay / pipeline pickup, not history.
const CAMERA_FRAME_TTL_SECONDS = 60;

export function telemetryConsumer(ch: Channel) {
  return async (payload: TelemetryArrivedPayload): Promise<void> => {
    const { userId, deviceId, actionName, value, timestamp } = payload;

    // value can be a base64 image frame — never log it raw here, before the kind
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

  // 4. If this frame answers an in-flight on-demand capture (pipeline enrich stage),
  // resolve it. takePendingPicture is the arbiter against the request's own timeout —
  // whichever fires first wins, so this is a no-op if the timeout already resolved it.
  if (commandId) {
    timeout.clear(commandId);
    try {
      const pending = await takePendingPicture(commandId);
      if (pending !== null) {
        const result: PictureResultPayload = { commandId, status: 'ok', image: frame, capturedAt: timestamp };
        publish(ch, RK.PICTURE_RESULT, result);
      }
    } catch (err) {
      log.error({ err, commandId }, 'picture request resolution failed');
    }
  }

  // Never log `frame` itself — it's a base64 JPEG, easily hundreds of KB.
  log.info({ userDeviceId, userActionId, frameSizeBytes: frame.length, commandId }, 'camera frame stored');
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
  await firePipelineTriggers(ch, userId, userActionId, value);
}

function evaluateThreshold(value: unknown, operator: string, threshold: string): boolean {
  const v = parseFloat(String(value));
  const t = parseFloat(threshold);
  if (isNaN(v) || isNaN(t)) return String(value) === threshold;
  switch (operator) {
    case '>':  return v > t;
    case '<':  return v < t;
    case '>=': return v >= t;
    case '<=': return v <= t;
    case '=':
    case '==': return v === t;
    default:   return false;
  }
}

async function firePipelineTriggers(
  ch: Channel,
  userId: string,
  userActionId: number,
  value: unknown,
): Promise<void> {
  try {
    const triggers = await db.pipelineTrigger.findMany({
      where: {
        pipeline:              { enabled: true, user_id: parseInt(userId, 10) },
        trigger_type:          'sensor_threshold',
        user_device_action_id: userActionId,
      },
      include: { pipeline: { select: { id: true, user_id: true } } },
    });

    for (const trigger of triggers) {
      if (!evaluateThreshold(value, trigger.operator!, trigger.threshold_value!)) continue;

      if (trigger.min_interval_sec) {
        const ck = `pipeline:cooldown:${trigger.id}`;
        const locked = await valkey.get(ck);
        if (locked) continue;
        await valkey.set(ck, '1', 'EX', trigger.min_interval_sec);
      }

      const run = await db.pipelineRun.create({
        data: {
          pipeline_id:     trigger.pipeline.id,
          status:          'queued',
          trigger_type:    'sensor_threshold',
          trigger_payload: { triggerId: trigger.id, actionId: userActionId, value: String(value) } as Prisma.InputJsonValue,
        },
      });

      publish(ch, RK.PIPELINE_TRIGGER, {
        userId:     String(trigger.pipeline.user_id),
        pipelineId: String(trigger.pipeline.id),
        runId:      run.id,
        deviceId:   undefined,
        actionName: undefined,
        value,
        timestamp:  new Date().toISOString(),
      });
    }
  } catch (err) {
    log.error({ err, userActionId }, 'pipeline trigger check failed (best-effort)');
  }
}
