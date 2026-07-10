import { valkey, keys } from '../cache/valkey';
import { env } from '../config/env.config';

// Suppress a repeat of the same (userId, eventType[, dedupeKey]) within the dedupe window.
// SET NX EX: the first write wins and returns 'OK'; a repeat inside the TTL returns null.
// Returns true when the notification is a duplicate and should be dropped.
export async function isDuplicate(
  userId: number,
  eventType: string,
  dedupeKey?: string,
): Promise<boolean> {
  const key = keys.dedupe(userId, eventType, dedupeKey);
  const res = await valkey.set(key, '1', 'EX', env.dedupeTtlSeconds, 'NX');
  return res === null;
}
