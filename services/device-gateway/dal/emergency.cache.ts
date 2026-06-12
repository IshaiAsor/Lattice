import IORedis from 'ioredis';
import config from '../config/env.config';
import { deviceGatewayRepository } from './device.gateway.repository';
import type { EmergencyRule } from '@lattice/prisma-client';

const TTL_1H = 3_600;

class EmergencyCache {
  private client: IORedis;

  constructor() {
    this.client = new IORedis(config.valkey.url, {
      username: config.valkey.username,
      password: config.valkey.password,
      lazyConnect: true,
    });
  }

  private key(userId: number) { return `emergency_rules:${userId}`; }

  async warm(userId: number): Promise<EmergencyRule[]> {
    const rules = await deviceGatewayRepository.getEnabledEmergencyRules(userId);
    await this.client.set(this.key(userId), JSON.stringify(rules), 'EX', TTL_1H);
    return rules;
  }

  async invalidate(userId: number): Promise<void> {
    await this.client.del(this.key(userId));
  }

  async getForUser(userId: number): Promise<EmergencyRule[]> {
    const raw = await this.client.get(this.key(userId));
    if (raw) return JSON.parse(raw) as EmergencyRule[];
    return this.warm(userId);
  }

  /** Returns enabled rules matching this specific action or its capability. */
  async getMatchingRules(userId: number, actionId: number, capability: string): Promise<EmergencyRule[]> {
    const all = await this.getForUser(userId);
    return all.filter((r) =>
      (r.source_scope === 'instance'   && r.source_user_action_id === actionId) ||
      (r.source_scope === 'capability' && r.source_capability     === capability),
    );
  }
}

export const emergencyCache = new EmergencyCache();
