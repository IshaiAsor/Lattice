import IORedis from 'ioredis';
import config from '../config/env.config';
import { deviceGatewayRepository } from './device.gateway.repository';

// ─── Valkey key schema (device-gateway owns these) ───────────────────────────
//
//  action_state:{userActionId}             current state string            TTL 24h
//  device_map:{macId}                      {userId,userDeviceId} JSON      TTL 24h
//  action_map:{userDeviceId}:{actionKey}   {userActionId,...} JSON         TTL 24h
//  device_online:{userDeviceId}            '1'                             TTL 90s (refreshed on heartbeat)
//  camera_frame:{userDeviceId}             base64 string                   TTL 30s

export type DeviceMapEntry  = { userId: number; userDeviceId: number };
export type ActionMapEntry  = {
  userActionId: number;
  userActionDefId: number;
  capability: string;
  mqttType: string | null;
  mqttName: string | null;
};

const TTL_24H = 86_400;
const TTL_90S = 90;
const TTL_30S = 30;

class DeviceCache {
  private client: IORedis;

  constructor() {
    this.client = new IORedis(config.valkey.url, {
      username: config.valkey.username,
      password: config.valkey.password,
      lazyConnect: true,
    });
  }

  // ─── Device map (macId → userId + userDeviceId) ──────────────────────────

  async getDeviceMap(macId: string): Promise<DeviceMapEntry | null> {
    const raw = await this.client.get(`device_map:${macId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async setDeviceMap(macId: string, entry: DeviceMapEntry): Promise<void> {
    await this.client.set(`device_map:${macId}`, JSON.stringify(entry), 'EX', TTL_24H);
  }

  async invalidateDeviceMap(macId: string): Promise<void> {
    await this.client.del(`device_map:${macId}`);
  }

  /** Resolve device from cache, falling back to DB on miss. */
  async resolveDevice(macId: string): Promise<DeviceMapEntry | null> {
    const cached = await this.getDeviceMap(macId);
    if (cached) return cached;

    const device = await deviceGatewayRepository.getDeviceByMacId(macId);
    if (!device) return null;

    const entry: DeviceMapEntry = { userId: device.user_id, userDeviceId: device.id };
    await this.setDeviceMap(macId, entry);
    return entry;
  }

  // ─── Action map (userDeviceId + actionKey → action info) ─────────────────

  async getActionMap(userDeviceId: number, actionKey: string): Promise<ActionMapEntry | null> {
    const raw = await this.client.get(`action_map:${userDeviceId}:${actionKey}`);
    return raw ? JSON.parse(raw) : null;
  }

  async setActionMap(userDeviceId: number, actionKey: string, entry: ActionMapEntry): Promise<void> {
    await this.client.set(`action_map:${userDeviceId}:${actionKey}`, JSON.stringify(entry), 'EX', TTL_24H);
  }

  async invalidateActionMap(userDeviceId: number): Promise<void> {
    const keys = await this.client.keys(`action_map:${userDeviceId}:*`);
    if (keys.length) await this.client.del(...keys);
  }

  /** Resolve action from cache, falling back to DB on miss. */
  async resolveAction(userDeviceId: number, actionKey: string): Promise<ActionMapEntry | null> {
    const cached = await this.getActionMap(userDeviceId, actionKey);
    if (cached) return cached;

    const actions = await deviceGatewayRepository.getActionsByDeviceId(userDeviceId);
    const match = actions.find((a) => a.action_def.action_key === actionKey);
    if (!match) return null;

    const entry: ActionMapEntry = {
      userActionId:    match.id,
      userActionDefId: match.action_def.id,
      capability:      match.action_def.capability,
      mqttType:        match.action_def.mqtt_type,
      mqttName:        match.action_def.mqtt_name,
    };

    await this.setActionMap(userDeviceId, actionKey, entry);

    // Pre-warm all other actions for this device in one pass
    for (const a of actions) {
      if (a.action_def.action_key !== actionKey) {
        await this.setActionMap(userDeviceId, a.action_def.action_key, {
          userActionId:    a.id,
          userActionDefId: a.action_def.id,
          capability:      a.action_def.capability,
          mqttType:        a.action_def.mqtt_type,
          mqttName:        a.action_def.mqtt_name,
        });
      }
    }

    return entry;
  }

  // ─── Action state (current value) ────────────────────────────────────────

  async setState(userActionId: number, value: string): Promise<void> {
    await this.client.set(`action_state:${userActionId}`, value, 'EX', TTL_24H);
  }

  async getState(userActionId: number): Promise<string | null> {
    return this.client.get(`action_state:${userActionId}`);
  }

  // ─── Online heartbeat ─────────────────────────────────────────────────────

  async markOnline(userDeviceId: number): Promise<void> {
    await this.client.set(`device_online:${userDeviceId}`, '1', 'EX', TTL_90S);
  }

  async isOnline(userDeviceId: number): Promise<boolean> {
    return (await this.client.exists(`device_online:${userDeviceId}`)) === 1;
  }

  // ─── Camera frame ─────────────────────────────────────────────────────────

  async storeFrame(userDeviceId: number, frame: string): Promise<void> {
    await this.client.set(`camera_frame:${userDeviceId}`, frame, 'EX', TTL_30S);
  }

  async getFrame(userDeviceId: number): Promise<string | null> {
    return this.client.get(`camera_frame:${userDeviceId}`);
  }

  getClient(): IORedis { return this.client; }
}

export const deviceCache = new DeviceCache();
