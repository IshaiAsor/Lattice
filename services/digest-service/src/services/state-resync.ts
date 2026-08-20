import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionReadRequestedPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';

const log = createLogger('digest-service:state-resync');

/**
 * Ask a device to confirm the state of every command action it owns (F23.4).
 *
 * Called at the moment a device comes back after being away, which is the single most likely
 * time the stored state is wrong: anything that changed while it was gone — a duration releasing
 * on-device, a reboot restoring NVS, an ack lost to the disconnect itself — went unwitnessed. The
 * periodic sweep would find it eventually; this finds it now.
 *
 * Best-effort throughout. A resync that fails to publish costs a window of staleness, not
 * correctness, and must never take down the liveness write that triggered it.
 */
export async function resyncDeviceState(
  ch: Channel,
  userId: string,
  userDeviceId: number,
  reason: ActionReadRequestedPayload['reason'] = 'reconnect',
): Promise<number> {
  try {
    const actions = await db.userDeviceAction.findMany({
      where: {
        user_device_id: userDeviceId,
        status: 'active',
        capability: { mqtt_action_type: 'command' },
      },
      select: { id: true },
    });
    if (actions.length === 0) return 0;

    for (const action of actions) {
      publish(ch, RK.ACTION_READ_REQUESTED, {
        userId,
        deviceId: String(userDeviceId),
        actionId: action.id,
        reason,
      } satisfies ActionReadRequestedPayload);
    }
    log.info({ userDeviceId, count: actions.length, reason }, 'requested state resync for device');
    return actions.length;
  } catch (err) {
    log.error({ err, userDeviceId }, 'state resync request failed — skipped');
    return 0;
  }
}
