import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from './db/client';
import { valkey, keys } from './cache/valkey';
import { asString } from './util';
import { socket } from './socket/emitter';

const log = createLogger('digest-service:state-write');

// Which path confirmed the state, recorded on the row so "we last heard this from the device two
// minutes ago" and "we wrote this ourselves an hour ago" stop being the same thing (F23).
export type StateSource = 'command-ack' | 'telemetry' | 'reconcile' | 'boot-restore';

export interface ScalarStateInput {
  userId: string;
  deviceId: string;
  actionName: string;
  value: unknown;
  timestamp: string;
  // Present for device acks, absent for telemetry. Forwarded to the UI so it can ignore
  // stale updates when two commands for the same action are in flight concurrently.
  commandId?: string;
  source: StateSource;
}

// Authoritative write of a confirmed scalar state for a UserDeviceAction. Shared by the
// telemetry consumer (sensor readings) and the action-result consumer (device acks): both
// represent the device's true, observed state, so they persist identically. The DB write
// is authoritative (caller lets a throw nack → DLQ); history/cache/socket/rules are
// best-effort.
export async function writeScalarState(
  ch: Channel,
  userActionId: number,
  input: ScalarStateInput,
): Promise<void> {
  const { userId, deviceId, actionName, value, timestamp, commandId, source } = input;
  const stateValue = asString(value);

  log.info({ userActionId, userId, deviceId, actionName, value }, 'writing scalar state');
  // 1. Authoritative state write — failure nacks → DLQ.
  await db.userDeviceAction.update({
    where: { id: userActionId },
    data: {
      current_state: stateValue,
      updated_at: new Date(),
      // Every caller here is a confirmation from the device, so the freshness stamp belongs on
      // all of them — not only on the reconcile path that made it necessary.
      last_confirmed_at: new Date(),
      state_source: source,
    },
  });

  // 2. Append to sensor history (best-effort).
  try {
    await db.sensorHistory.create({
      data: {
        user_device_action_id: userActionId,
        value: stateValue,
        recorded_at: new Date(timestamp),
      },
    });
  } catch (err) {
    log.error({ err, userActionId }, 'sensor_history insert failed');
  }

  // 3. Hot cache (best-effort).
  try {
    await valkey.set(keys.actionState(userActionId), stateValue, 'EX', 3600);
  } catch (err) {
    log.error({ err, userActionId }, 'valkey action_state set failed');
  }

  // 4. Push to the UI (best-effort).
  try {
    socket.emitActionStateUpdate(parseInt(userId, 10), userActionId, value, commandId);
  } catch (err) {
    log.error({ err, userActionId }, 'socket emit failed');
  }

  // 5. Fan out to rules evaluation (best-effort).
  try {
    publish(ch, RK.RULES_EVALUATE, { userId, deviceId, actionName, value, timestamp });
  } catch (err) {
    log.error({ err, userActionId }, 'rules.evaluate publish failed');
  }

  log.info({ userActionId, stateValue }, 'scalar state write complete');
}

export interface ReconcileStateInput extends Omit<ScalarStateInput, 'commandId' | 'source'> {
  // What the DB believed when the read was dispatched. Compared against what the device just
  // reported — as of dispatch, not as of now, so a command that landed in between is not misread
  // as drift.
  expectedState: string | null;
}

// The answer to a state read-back (F23.3b). Splits on divergence, and the split is the whole
// point: writeScalarState is not idempotent. Every call appends a sensor_history row and
// re-publishes rules.evaluate, so running it per read would cost thousands of history rows and
// rule evaluations a day per device to record that nothing changed.
//
// Match     → a timestamp-only update. Nothing observed, nothing to tell anyone.
// Divergence → the full write, side effects included: the state genuinely was wrong, so the
//              history row is a real observation and the rules pass is one that should happen.
//
// Note the deliberate absence of a commandId on the divergence write. The UI drops updates
// carrying a commandId it did not issue (it reads them as a stale echo of someone else's
// command), and this is not an echo — it is the authoritative correction.
export async function reconcileState(
  ch: Channel,
  userActionId: number,
  input: ReconcileStateInput,
): Promise<boolean> {
  const { expectedState, value, ...rest } = input;
  const reported = asString(value);

  if (reported === expectedState) {
    const confirmedAt = new Date();
    await db.userDeviceAction.update({
      where: { id: userActionId },
      data: { last_confirmed_at: confirmedAt, state_source: 'reconcile' },
    });
    // Freshness only — see emitActionStateConfirmed. Best-effort like every other socket emit.
    try {
      socket.emitActionStateConfirmed(
        parseInt(rest.userId, 10),
        userActionId,
        confirmedAt.toISOString(),
      );
    } catch (err) {
      log.error({ err, userActionId }, 'socket confirm emit failed');
    }
    log.debug({ userActionId, state: reported }, 'state confirmed unchanged by read-back');
    return false;
  }

  log.warn(
    { userActionId, stored: expectedState, reported, deviceId: rest.deviceId },
    'state divergence — correcting to the device value',
  );
  await writeScalarState(ch, userActionId, { ...rest, value, source: 'reconcile' });
  return true;
}
