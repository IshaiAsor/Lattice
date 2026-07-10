import IORedis from 'ioredis';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';

const log = createLogger('notification-service:valkey');

// Shared Valkey client. The in-app channel wraps this in a redis-emitter (same instance
// socket-server's adapter listens on); F15.3 also uses it for dedupe/rate-limit keys.
export const valkey = new IORedis(env.valkey.url, {
  username: env.valkey.username,
  password: env.valkey.password,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

valkey.on('error', (err) => log.error({ err }, 'valkey connection error'));

export const keys = {
  // Dedupe guard per (userId, eventType[, dedupeKey]) — SET NX with env.dedupeTtlSeconds (F15.3).
  dedupe: (userId: number, eventType: string, dedupeKey?: string) =>
    `notif:dedupe:${userId}:${eventType}${dedupeKey ? `:${dedupeKey}` : ''}`,
};
