import { valkey, keys } from './valkey';

// Context for an in-flight command awaiting the device's ack. Stored in Valkey keyed by
// commandId so either the ack consumer or the timeout can resolve it — whichever calls
// takePending first wins (atomic GETDEL), guaranteeing the UI is settled exactly once.
export interface PendingCommand {
  userId: string;
  actionId: number;
  deviceId: string;
  actionName: string;
  value: unknown;
}

// Persist the pending command with a TTL slightly longer than the ack timeout, so a
// crashed/restarted process never leaves a dangling key.
export async function setPending(
  commandId: string,
  pending: PendingCommand,
  ttlSeconds: number,
): Promise<void> {
  await valkey.set(keys.pendingCommand(commandId), JSON.stringify(pending), 'EX', ttlSeconds);
}

// Atomically read-and-delete the pending record. Returns null if it was already taken
// (resolved by the other path) or never existed. GETDEL is the single arbiter between
// the ack consumer and the timeout firing.
export async function takePending(commandId: string): Promise<PendingCommand | null> {
  const raw = await valkey.getdel(keys.pendingCommand(commandId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PendingCommand;
  } catch {
    return null;
  }
}

// Context for an in-flight on-demand picture capture awaiting the device's uploaded frame.
// Same setPending/takePending/timeout shape as PendingCommand, kept separate since the
// request/response fields don't overlap (no value/actionName to echo, just who to notify).
export interface PendingPicture {
  userId: string;
  actionId: number;
  /**
   * Whether to publish PICTURE_RESULT once this settles — carried here, not just in the request
   * closure, because the frame path settles it from a different message entirely and has only the
   * commandId to go on. Absent means deliver (pre-existing requests, and ml-router's).
   */
  deliverResult?: boolean;
}

export async function setPendingPicture(
  commandId: string,
  pending: PendingPicture,
  ttlSeconds: number,
): Promise<void> {
  await valkey.set(keys.pendingPicture(commandId), JSON.stringify(pending), 'EX', ttlSeconds);
}

export async function takePendingPicture(commandId: string): Promise<PendingPicture | null> {
  const raw = await valkey.getdel(keys.pendingPicture(commandId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PendingPicture;
  } catch {
    return null;
  }
}
