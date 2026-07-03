import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { PictureRequestedPayload, ActionDispatchPayload, PictureResultPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { setPendingPicture, takePendingPicture } from '../cache/pending';
import * as timeout from '../pending-timeout';

const log = createLogger('digest-service:picture-requested');

// ml-router's request for a fresh camera frame, mirroring actionRequestedConsumer's
// dispatch-and-arm-timeout shape. The device's uploaded frame (routed through the ordinary
// telemetry.consumer.ts handleImage path, tagged with this commandId) resolves the pending
// request; a timeout publishes PICTURE_RESULT with status 'timeout' so ml-router can fall
// back to the last durably-stored frame instead of hanging.
export function pictureRequestedConsumer(ch: Channel) {
  return async (payload: PictureRequestedPayload): Promise<void> => {
    const { userId, actionId, commandId, timeoutMs } = payload;
    log.trace({ userId, actionId, commandId, timeoutMs }, 'picture.requested received');

    const row = await db.userDeviceAction.findUnique({
      where:  { id: actionId },
      select: {
        user_device_id:   true,
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
      await setPendingPicture(commandId, { userId, actionId }, ttlSeconds);
    } catch (err) {
      log.error({ err, actionId, commandId }, 'pending picture set failed');
    }

    // Dispatch take_picture through the same generic ACTION_DISPATCH path every other
    // command uses — mqtt-service just publishes payload.command to .../command/{actionName},
    // it doesn't care whether the action is command- or telemetry-class on the device side.
    const dispatch: ActionDispatchPayload = {
      userId,
      deviceId,
      actionName:      'take_picture',
      command:         { commandId },
      commandId,
      firmwareVersion: row.user_device.device.version,
    };
    try {
      publish(ch, RK.ACTION_DISPATCH, dispatch);
    } catch (err) {
      log.error({ err, actionId }, 'take_picture dispatch publish failed');
    }

    // Arm the no-response timeout. takePendingPicture is the arbiter: if the frame already
    // resolved the request, the record is gone and we do nothing.
    timeout.arm(commandId, timeoutMs, () => {
      takePendingPicture(commandId)
        .then((pending) => {
          if (pending === null) return; // already resolved by an uploaded frame
          log.warn({ actionId, commandId }, 'picture request timed out with no frame');
          const result: PictureResultPayload = { commandId, status: 'timeout' };
          publish(ch, RK.PICTURE_RESULT, result);
        })
        .catch((err) => log.error({ err, commandId }, 'pending picture timeout resolution failed'));
    });
  };
}
