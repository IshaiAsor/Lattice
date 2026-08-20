import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionReadRequestedPayload, DeviceStateChangedPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { env } from '../config/env.config';
import { confirmationAge } from '../metrics';

const log = createLogger('automation-worker:reconcile');

// State reconciliation (F23).
//
// A command action's `current_state` is not an observation — it is a cache of the last ack the
// platform happened to see. Telemetry actions self-correct on the next reading; command actions
// have no such loop, so one lost ack leaves the row wrong indefinitely and nothing notices. These
// sweeps are that missing loop: ask the device what it actually is, and let digest correct the row
// when the answer differs.
//
// Nothing here decides anything about state. It only selects who is worth asking and paces the
// asking; the comparison, the correction and the divergence log all live in digest.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask devices to confirm the state of command actions whose confirmation has gone stale.
 *
 * Bounded on both axes on purpose: `batchSize` caps the pass and `spacingMs` spreads it, so a
 * device with twenty actions is never read twenty times at once. Nothing claims a row — the
 * confirmation timestamp is its own claim, since an action that answers moves out of the window
 * and one that does not is legitimately due again next pass.
 */
export async function sweepUnconfirmedActions(ch: Channel): Promise<number> {
  if (!env.reconcile.enabled) return 0;
  try {
    const now = Date.now();
    const candidates = await db.userDeviceAction.findMany({
      where: {
        status: 'active',
        // Command surface only. A telemetry action's cyclic reading already re-confirms it, so
        // reading it here would buy nothing and cost a message per action per window.
        capability: { mqtt_action_type: 'command' },
        user_device: {
          online: true,
          // `online` alone is not trustworthy: a device that loses power delivers no Last-Will,
          // so its row can read online indefinitely. Requiring a recent heartbeat keeps the pass
          // from being spent on devices that are gone. (The reaper below eventually corrects the
          // column itself, but this must hold regardless of when it last ran.)
          last_heartbeat_at: { gte: new Date(now - env.reconcile.livenessMs) },
        },
        OR: [
          { last_confirmed_at: null },
          { last_confirmed_at: { lt: new Date(now - env.reconcile.windowMs) } },
        ],
      },
      select: {
        id: true,
        last_confirmed_at: true,
        user_device: { select: { id: true, user_id: true } },
      },
      // Never-confirmed first, then oldest — so a backlog drains in the order of least confidence
      // rather than by id.
      orderBy: { last_confirmed_at: { sort: 'asc', nulls: 'first' } },
      take: env.reconcile.batchSize,
    });

    let issued = 0;
    for (const action of candidates) {
      // Recorded before the read, not after: this measures how stale the fleet was allowed to get,
      // which is the question the sweep exists to answer. A never-confirmed action is left out
      // rather than recorded as infinitely old — "we have never known" is a different fact from
      // "we knew, a long time ago", and folding it in would swamp every percentile.
      if (action.last_confirmed_at !== null) {
        confirmationAge.record((now - action.last_confirmed_at.getTime()) / 1000);
      }

      const request: ActionReadRequestedPayload = {
        userId: String(action.user_device.user_id),
        deviceId: String(action.user_device.id),
        actionId: action.id,
        reason: 'sweep',
      };
      publish(ch, RK.ACTION_READ_REQUESTED, request);
      issued++;
      if (env.reconcile.spacingMs > 0) await sleep(env.reconcile.spacingMs);
    }

    if (issued > 0) log.info({ issued }, 'reconcile sweep dispatched state reads');
    return issued;
  } catch (err) {
    log.error({ err }, 'error sweeping unconfirmed actions');
    return 0;
  }
}

/**
 * Settle commands that were dispatched and never answered, then re-read what they addressed.
 *
 * digest arms an ack timeout in process memory, which means a restart drops every timer that was
 * in flight — and a command issued to a device that is simply not listening was never armed at
 * all. Both leave a row `sent` forever. This is the durable backstop: mark them timed out, and
 * because a timed-out command is precisely a case where the stored state may now be a lie, ask
 * the device what it really is.
 */
export async function sweepUnsettledCommands(ch: Channel): Promise<number> {
  if (!env.reconcile.enabled) return 0;
  try {
    const cutoff = new Date(Date.now() - env.reconcile.settleWindowMs);
    const stranded = await db.deviceCommand.findMany({
      where: { settled_at: null, dispatched_at: { lt: cutoff }, status: 'sent' },
      select: {
        id: true,
        user_id: true,
        user_device_id: true,
        user_device_action_id: true,
      },
      take: env.reconcile.batchSize,
    });

    let settled = 0;
    // One read per ACTION, not per command. A backlog is usually many commands against the same
    // few actions (a device that was offline for an hour), and the answer to "what state is this
    // action in" is the same however many times it was asked to change — so reading once per
    // command would flood the device to learn one fact repeatedly.
    const toRead = new Map<number, ActionReadRequestedPayload>();

    for (const cmd of stranded) {
      await db.deviceCommand.update({
        where: { id: cmd.id },
        data: { status: 'timeout', settled_at: new Date() },
      });
      settled++;

      // An unresolvable command has nothing to re-read — it is recorded for history's sake and
      // that is all it can be.
      if (cmd.user_device_action_id === null || cmd.user_device_id === null) continue;
      toRead.set(cmd.user_device_action_id, {
        userId: String(cmd.user_id),
        deviceId: String(cmd.user_device_id),
        actionId: cmd.user_device_action_id,
        reason: 'unsettled',
      });
    }

    for (const request of toRead.values()) {
      publish(ch, RK.ACTION_READ_REQUESTED, request);
      if (env.reconcile.spacingMs > 0) await sleep(env.reconcile.spacingMs);
    }

    if (settled > 0) log.warn({ settled }, 'settled stranded commands as timed out');
    return settled;
  } catch (err) {
    log.error({ err }, 'error settling stranded commands');
    return 0;
  }
}

/**
 * Mark devices offline once they have stopped heartbeating.
 *
 * Offline detection was purely the broker's Last-Will, which only arrives on a disconnect the
 * broker witnesses. A device that loses power sends no will, so its row read `online = true`
 * indefinitely — the platform's liveness was only ever as good as the failure being a polite one.
 *
 * It publishes DEVICE_STATE_CHANGED rather than writing the column itself: digest owns that write
 * (with the newest-wins guard the Last-Will race needs), the cache delete, the socket emit and the
 * offline notification. Duplicating any of that here would make two writers of one column.
 * `version` is deliberately omitted — the stale-retained guard exists to judge messages that came
 * off the broker, and this one did not.
 */
export async function reapSilentDevices(ch: Channel): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - env.liveness.timeoutMs);
    const silent = await db.userDevice.findMany({
      where: {
        online: true,
        // A device that has never heartbeated at all is not evidence of death: it may predate
        // heartbeat support, or simply not have sent its first one yet. Only silence that
        // followed a heartbeat is a signal.
        last_heartbeat_at: { not: null, lt: cutoff },
      },
      select: { id: true, user_id: true, last_heartbeat_at: true },
    });

    for (const device of silent) {
      const payload: DeviceStateChangedPayload = {
        userId: String(device.user_id),
        deviceId: String(device.id),
        actionName: 'status',
        state: false,
        timestamp: new Date().toISOString(),
      };
      publish(ch, RK.DEVICE_STATE_CHANGED, payload);
      log.warn(
        { userDeviceId: device.id, lastHeartbeatAt: device.last_heartbeat_at },
        'device stopped heartbeating with no Last-Will — marking offline',
      );
    }

    return silent.length;
  } catch (err) {
    log.error({ err }, 'error reaping silent devices');
    return 0;
  }
}
