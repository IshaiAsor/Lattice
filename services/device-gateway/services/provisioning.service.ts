import { deviceGatewayRepository } from '../dal/device.gateway.repository';
import { deviceCache } from '../dal/device.cache';
import { jwtService, JwtPurpose } from './jwt.service';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway:provisioning');

export type CapabilityReport = {
  capability: string;
  action_key: string;
  mqtt_type: string;
  google_action_type: string;
  google_traits: string[];
  pin_types?: string[];
};

export type ProvisionRegisterInput = {
  mac_id: string;
  model_key: string;
  version: string;
  userId?: number;
  capabilities?: CapabilityReport[];
};

export type ProvisionRegisterResult = {
  token: string;
  refreshToken: string;
  deviceId: number;
};

class ProvisioningService {
  /**
   * Single-step registration. Called after the device has already tested its MQTT
   * connection with the provisioning token.
   *
   * Re-provisioning (mac_id already in DB): issues fresh tokens, no DB changes.
   * New device: finds or auto-creates an unbound slot, upserts capability defs,
   * binds mac_id, issues permanent device_usage tokens.
   */
  async register(input: ProvisionRegisterInput): Promise<ProvisionRegisterResult> {
    const { mac_id, model_key: modelKey, version, userId, capabilities } = input;

    // ── Re-provisioning: device already in DB ─────────────────────────────────
    const existing = await deviceGatewayRepository.getDeviceByMacId(mac_id);
    if (existing) {
      log.info({ mac_id, deviceId: existing.id }, 'Re-provisioning — issuing fresh tokens');
      const payload = { id: existing.user_id, deviceId: existing.id, mac_id };
      return {
        token:        jwtService.generate(payload, JwtPurpose.device_usage),
        refreshToken: jwtService.generate(payload, JwtPurpose.device_usage_refresh),
        deviceId:     existing.id,
      };
    }

    // ── New device ────────────────────────────────────────────────────────────
    if (!userId) {
      throw Object.assign(new Error('Could not resolve user from provisioning token'), { status: 401 });
    }

    // Find a pre-created unbound slot or auto-create one
    let slot = await deviceGatewayRepository.getUnboundDevice(userId, modelKey);
    if (!slot) {
      log.info({ user_id: userId, model_key: modelKey }, 'No unbound slot — creating one');
      slot = await deviceGatewayRepository.createDeviceSlot(userId, modelKey, version);
    }

    // Persist device-reported capabilities as UserActionDef rows (idempotent)
    if (capabilities?.length) {
      await deviceGatewayRepository.upsertActionDefs(slot.user_device_model_id, capabilities);
      log.info({ user_id: userId, model_key: modelKey, count: capabilities.length }, 'Upserted capability defs');
    }

    // Bind the physical device's MAC to the slot
    await deviceGatewayRepository.bindDevice(slot.id, mac_id);

    // Invalidate any cached state so the gateway picks up the new binding
    await deviceCache.invalidateDeviceMap(mac_id);
    await deviceCache.invalidateActionMap(slot.id);

    const payload = { id: userId, deviceId: slot.id, mac_id };
    return {
      token:        jwtService.generate(payload, JwtPurpose.device_usage),
      refreshToken: jwtService.generate(payload, JwtPurpose.device_usage_refresh),
      deviceId:     slot.id,
    };
  }

  refreshToken(userId: number, userDeviceId: number, macId: string): string {
    return jwtService.generate(
      { id: userId, deviceId: userDeviceId, mac_id: macId },
      JwtPurpose.device_usage,
    );
  }
}

export const provisioningService = new ProvisioningService();
