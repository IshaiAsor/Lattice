import Redis from 'ioredis';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';

type Log = ReturnType<typeof createLogger>;

// Creates a Redis (Valkey) connection wired with an error handler. Each pub/sub worker
// builds one subscriber + one publisher with this; `label` distinguishes them in logs.
export function createRedisClient(log: Log, label: string): Redis {
  const client = new Redis(env.valkey.url, {
    username: env.valkey.username,
    password: env.valkey.password,
  });
  client.on('error', (err) => log.error({ err }, `Redis ${label} error`));
  return client;
}
