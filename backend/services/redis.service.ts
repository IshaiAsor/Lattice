import IORedis from 'ioredis';
import config from '../config/env.config';
import { createLogger } from '@lattice/logger';

const log = createLogger('api:valkey');

// Shared Valkey client used by google.routes for OAuth code storage.
// (This service will move to google-home-service in Phase 6.)
class ValkeyService {
  private client: IORedis;

  constructor() {
    this.client = new IORedis(config.valkey.url, {
      username: config.valkey.username,
      password: config.valkey.password,
      lazyConnect: true,
    });
    this.client.on('error', (err) => log.error(err, 'Valkey error'));
  }

  async setTempData(key: string, value: unknown, ttlInSeconds: number): Promise<void> {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    await this.client.set(key, str, 'EX', ttlInSeconds);
  }

  async getTempData<T>(key: string): Promise<T | null> {
    const data = await this.client.get(key);
    if (!data) return null;
    try { return JSON.parse(data) as T; } catch { return data as unknown as T; }
  }

  async deleteTempData(key: string): Promise<void> {
    await this.client.del(key);
  }
}

export const redisService = new ValkeyService();
