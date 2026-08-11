import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type {
  PictureRequestedPayload,
  ActionDispatchPayload,
  PictureResultPayload,
} from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { setPendingPicture, takePendingPicture } from '../cache/pending';
import { recordTimeout } from '../command-history';
import * as timeout from '../pending-timeout';

const log = createLogger('digest-service:picture-requested');

// A request for a fresh camera frame — ml-router's, for a pipeline's enrich stage, or the api's
// when a user asks from the camera card — mirroring actionRequestedConsumer's dispatch-and-arm-
// timeout shape. The device's uploaded frame (routed through the ordinary telemetry.consumer.ts
// handleImage path, tagged with this commandId) resolves the pending request; a timeout publishes
// PICTURE_RESULT with status 'timeout' so ml-router can fall back to the last durably-stored frame
// instead of hanging.
export function pictureRequestedConsumer(ch: Channel) {
  return async (payload: PictureRequestedPayload): Promise<void> => {
    const { userId, actionId, commandId, timeoutMs, deliverResult = true } = payload;
    log.info(
      { userId, actionId, commandId, timeoutMs, source: payload.source?.kind },
      'picture.requested received',
    );

    const row = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: {
        user_device_id: true,
        mqtt_action_name: true,
        user_device: { select: { device: { select: { version: true } } } },
      },
    });
    if (!row) {
      // Unknown action — throw so the message nacks → DLQ for visibility.
      log.error({ userId, actionId }, 'unresolved action on picture request → DLQ');
      throw new Error(`unresolved action ${actionId}`);
    }

    const deviceId = String(row.user_device_id);

    // Record the in-flight request so the frame upload (or timeout) can resolve it. TTL
    // outlives the timeout so a crash can't leak the key.
    const ttlSeconds = Math.ceil(timeoutMs / 1000) + 30;
    try {
      await setPendingPicture(commandId, { userId, actionId, deliverResult }, ttlSeconds);
    } catch (err) {
      log.error({ err, actionId, commandId }, 'pending picture set failed');
    }

    // Dispatch take_picture through the same generic ACTION_DISPATCH path every other
    // command uses — mqtt-service just publishes payload.command to .../command/{actionName},
    // it doesn't care whether the action is command- or telemetry-class on the device side.
    // That path is also where command history records the capture, which is why source and
    // actionId ride along: a row that cannot say who asked answers nothing later.
    const dispatch: ActionDispatchPayload = {
      userId,
      deviceId,
      actionName: 'take_picture',
      command: { commandId },
      commandId,
      firmwareVersion: row.user_device.device.version,
      source: payload.source ?? { kind: 'system' },
      actionId,
    };
    try {
      publish(ch, RK.ACTION_DISPATCH, dispatch);
      log.info({ actionId, commandId, deviceId }, 'take_picture dispatched to device');
    } catch (err) {
      log.error({ err, actionId }, 'take_picture dispatch publish failed');
    }

    // Arm the no-response timeout. takePendingPicture is the arbiter: if the frame already
    // resolved the request, the record is gone and we do nothing.
    timeout.arm(commandId, timeoutMs, () => {
      takePendingPicture(commandId)
        .then(async (pending) => {
          if (pending === null) return; // already resolved by an uploaded frame
          log.warn({ actionId, commandId }, 'picture request timed out with no frame');
          // Same verdict, made durable. Without it a capture that never came back left nothing
          // but this log line — the whole reason a camera going quiet was invisible.
          await recordTimeout(commandId);
          if (!(pending.deliverResult ?? true)) return;
          const result: PictureResultPayload = { commandId, status: 'timeout' };
          publish(ch, RK.PICTURE_RESULT, result);
        })
        .catch((err) => log.error({ err, commandId }, 'pending picture timeout resolution failed'));
    });
  };
}
