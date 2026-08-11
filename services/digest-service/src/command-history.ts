import type { ActionDispatchPayload, ActionResultPayload, CommandSource } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from './db/client';
import { resolveUserDeviceAction } from './resolve';

const log = createLogger('digest-service:command-history');

// The durable record of what the platform told devices to do, and what they said back (F11.12).
//
// Before this, a command left nothing behind: the in-flight record lived in Valkey under a TTL and
// the only thing that outlived it was `current_state` — the last value, which cannot say who set
// it, when, or whether the device ever confirmed. "Why did the pump run at 3am" had no answer.
//
// Two writes, never more:
//
//   dispatch  one row, at the single point every command passes through whoever raised it.
//   ack       the same row settled in place — status, the state the device actually reported, when.
//
// Best-effort throughout. History is an observer: a failure to record must never nack a command or
// break the state write, so every entry point swallows its own errors and logs.

/** OTA is not a device action and has no UserDeviceAction behind it — it has its own audit trail. */
const NON_COMMAND_ACTIONS = new Set(['ota']);

// `take_picture` is deliberately NOT in that set, even though the camera is a read surface and the
// device treats the verb as an alias for `read`. A capture is still something the platform asked a
// device to do and can fail to get — and without a row, a capture that never came back left only a
// log line. Its rows are thinner than a command's by nature: `target_state` is empty because a
// capture targets no state, and the answer arrives out-of-band, so `recordCaptureArrived` settles
// them rather than the ack path.

/**
 * A command/ack value as one storable string, or null when there is none.
 *
 * Not `util.asString`, which types `JSON.stringify(undefined)` as a string it is not — here the
 * difference between "the device reported nothing" and the text "undefined" is the difference
 * between an honest history row and a misleading one. Truncated to the column width: a value long
 * enough to overflow it is not a state, and losing the row over one would be worse.
 */
function textOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 255);
}

/** What a dispatch's `command` body carries, as `{ value, duration }`. */
function readCommand(command: unknown): { value: string; durationSeconds: number | null } {
  const body = (command ?? {}) as Record<string, unknown>;
  const duration = textOf(body['duration']);
  // '*' is the wire form of "hold indefinitely" — not a number, and not a duration.
  const seconds = duration && duration !== '*' ? Number(duration) : NaN;
  return {
    value: textOf(body['value']) ?? '',
    durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  };
}

function sourceColumns(source: CommandSource | undefined) {
  return {
    source: source?.kind ?? 'system',
    source_ref_id: source?.refId ?? null,
    // Stored as text rather than looked up on read: the history has to keep reading correctly after
    // the rule that raised it is renamed or deleted.
    source_label: source?.label ?? null,
  };
}

/** One row per command, written as it goes out. */
export async function recordDispatch(payload: ActionDispatchPayload): Promise<void> {
  if (NON_COMMAND_ACTIONS.has(payload.actionName)) return;
  try {
    const { value, durationSeconds } = readCommand(payload.command);
    // The publisher usually knows the action id; when it doesn't, the same resolver the ack path
    // uses fills it in. A pair that resolves to nothing is still recorded — an unroutable command
    // is exactly the kind of thing this table exists to show.
    const actionId =
      payload.actionId ??
      (await resolveUserDeviceAction(payload.deviceId, payload.actionName))?.id ??
      null;

    await db.deviceCommand.create({
      data: {
        user_id: parseInt(payload.userId, 10),
        user_device_id: parseInt(payload.deviceId, 10),
        user_device_action_id: actionId,
        action_name: payload.actionName,
        target_state: value,
        duration_seconds: durationSeconds,
        ...sourceColumns(payload.source),
        status: 'sent',
        command_id: payload.commandId ?? null,
      },
    });
  } catch (err) {
    log.error({ err, commandId: payload.commandId }, 'command history write failed — not recorded');
  }
}

/**
 * The device's answer, written onto the row the command created.
 *
 * An ack with no command behind it is not a mistake: firmware reports state on its own when a
 * duration auto-off releases or a reboot restores. Those get their own row, sourced `device`,
 * because the whole point of the duration feature is being able to see that the release happened.
 */
export async function recordAck(payload: ActionResultPayload): Promise<void> {
  if (NON_COMMAND_ACTIONS.has(payload.actionName)) return;
  const status = payload.status === 'ok' ? 'ok' : 'error';
  const value = textOf(payload.value);
  const at = new Date();

  try {
    if (payload.commandId) {
      // updateMany, not update: an ack for a command this deployment never recorded (a restart
      // between dispatch and ack) must not throw — it simply matches nothing.
      const { count } = await db.deviceCommand.updateMany({
        where: { command_id: payload.commandId, settled_at: null },
        data: { status, result_value: value, settled_at: at },
      });
      if (count > 0) return;
      log.debug(
        { commandId: payload.commandId },
        'ack matched no open command row — recording it on its own',
      );
    }

    const actionId = (await resolveUserDeviceAction(payload.deviceId, payload.actionName))?.id;
    await db.deviceCommand.create({
      data: {
        user_id: parseInt(payload.userId, 10),
        user_device_id: parseInt(payload.deviceId, 10),
        user_device_action_id: actionId ?? null,
        action_name: payload.actionName,
        target_state: value ?? '',
        // Sourced `device`: nothing here asked for this. It is the device telling us what it did —
        // a duration releasing, or a boot restoring the state it held.
        source: 'device',
        source_ref_id: null,
        source_label: null,
        status,
        // Deliberately not the ack's commandId: it did not match an open row, and claiming the
        // unique key would then reject the real row if the dispatch is still in flight.
        command_id: null,
        result_value: value,
        settled_at: at,
      },
    });
  } catch (err) {
    log.error({ err, commandId: payload.commandId }, 'command history ack write failed');
  }
}

/**
 * A capture answered — the frame arrived and resolved its request.
 *
 * Its own settle path because a camera never acks: the frame comes back out-of-band (WS/HTTP →
 * telemetry), so nothing on the ack topic would ever close this row. What lands in `result_value`
 * is the frame's SIZE, never the frame — that column is 255 chars and the value here is a base64
 * JPEG, which would be sliced into a meaningless prefix.
 */
export async function recordCaptureArrived(commandId: string, frameBytes: number): Promise<void> {
  try {
    await db.deviceCommand.updateMany({
      where: { command_id: commandId, settled_at: null },
      data: { status: 'ok', result_value: `${frameBytes} bytes`, settled_at: new Date() },
    });
  } catch (err) {
    log.error({ err, commandId }, 'command history capture settle failed');
  }
}

/** The device never answered. Same outcome the UI is told, made durable. */
export async function recordTimeout(commandId: string): Promise<void> {
  try {
    await db.deviceCommand.updateMany({
      where: { command_id: commandId, settled_at: null },
      data: { status: 'timeout', settled_at: new Date() },
    });
  } catch (err) {
    log.error({ err, commandId }, 'command history timeout write failed');
  }
}
