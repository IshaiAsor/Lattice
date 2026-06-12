import IORedis from 'ioredis';
import config from '../config/env.config';
import { createLogger } from '@lattice/logger';

const log = createLogger('google-home:valkey');

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

  // OAuth code storage (10-minute TTL)
  async setOAuthCode(code: string, data: { userId: number; redirectUri: string }): Promise<void> {
    await this.client.set(`oauth_code:${code}`, JSON.stringify(data), 'EX', 600);
  }

  async getOAuthCode(code: string): Promise<{ userId: number; redirectUri: string } | null> {
    const raw = await this.client.get(`oauth_code:${code}`);
    return raw ? JSON.parse(raw) : null;
  }

  async deleteOAuthCode(code: string): Promise<void> {
    await this.client.del(`oauth_code:${code}`);
  }

  // Device action state (for fast QUERY responses)
  async getActionState(userActionId: number): Promise<string | null> {
    return this.client.get(`action_state:${userActionId}`);
  }

  async isDeviceOnline(userDeviceId: number): Promise<boolean> {
    return (await this.client.exists(`device_online:${userDeviceId}`)) === 1;
  }
}

export const valkeyService = new ValkeyService();
