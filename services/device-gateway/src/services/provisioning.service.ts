import { Prisma } from '@lattice/prisma-client';
import { db } from '../db';
import { jwtService, JwtPurpose } from './jwt.service';
import { env } from '../config/env.config';

export interface CapabilityInput {
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  configurable_pins?: { key: string; label: string; mode: string }[];
  min_telemetry_interval_ms?: number | null;
  google_action_type?: string | null;
  google_traits?: string[] | null;
}

class ProvisioningService {
  // Device-facing single call: upsert device type, capability blueprints, and the
  // user_device (by mac — re-provisioning always works), then return a permanent JWT.
  async provisionDevice(
    userId: number,
    macAddress: string,
    deviceType: string,
    version: string,
    capabilities: CapabilityInput[],
  ) {
    // 1. Upsert device type row.
    const device = await db.device.upsert({
      where: { type_version: { type: deviceType, version } },
      update: {},
      create: { type: deviceType, version, default_name: `${deviceType} ${version}` },
    });

    // 2. Upsert capability blueprints declared by the firmware.
    for (const cap of capabilities) {
      const data = {
        label: cap.label,
        implementation_type: cap.implementation_type,
        mqtt_action_type: cap.mqtt_action_type,
        mqtt_action_name: cap.mqtt_action_name,
        configurable_pins: cap.configurable_pins ?? [],
        min_telemetry_interval_ms: cap.min_telemetry_interval_ms ?? null,
        google_action_type: cap.google_action_type ?? null,
        google_traits: cap.google_traits ?? Prisma.JsonNull,
      };
      await db.deviceCapabilityBlueprint.upsert({
        where: { device_id_capability_key: { device_id: device.id, capability_key: cap.capability_key } },
        update: data,
        create: { device_id: device.id, capability_key: cap.capability_key, ...data },
      });
    }

    // 3. Upsert user_device by mac_id.
    const userDevice = await db.userDevice.upsert({
      where: { mac_id: macAddress },
      update: { user_id: userId, device_type_id: device.id },
      create: { user_id: userId, device_type_id: device.id, mac_id: macAddress, name: deviceType },
    });

    // 4. Return permanent JWT + URLs.
    return this.generatePermanentToken(userId, userDevice.id, version);
  }

  refreshMqttToken(refreshToken: string) {
    const result = jwtService.verifyToken(refreshToken, JwtPurpose.device_usage_refresh);
    if (!result.valid) {
      throw new Error('Invalid or expired refresh token');
    }
    return this.generatePermanentToken(
      result.decoded.userId,
      result.decoded.deviceId,
      result.decoded.version,
    );
  }

  // device_usage token keeps `{ userid, clientid }` (EMQX ACL keys off clientid=deviceId).
  // refresh token carries version so the refreshed config URL is correct.
  private generatePermanentToken(userId: number, deviceId: number, deviceVersion: string) {
    const token = jwtService.generateToken(
      { userid: userId, clientid: deviceId },
      JwtPurpose.device_usage,
    );
    const refreshToken = jwtService.generateToken(
      { userId, deviceId, version: deviceVersion },
      JwtPurpose.device_usage_refresh,
    );

    return {
      deviceId,
      mqttToken: token,
      refreshToken,
      refreshTokenCallbackUrl: `${env.DeviceGatewaybaseUrl}/api/provisioning/refresh-token`,
      deviceConfigUrl: `${env.DeviceGatewaybaseUrl}/api/device/configuration`,
      validateCACert: env.mqtt.validateCert,
      wsStreamUrl: env.DeviceGatewaybaseUrl,
      cameraHttpUrl: env.DeviceGatewaybaseUrl,
    };
  }
}

export const provisioningService = new ProvisioningService();
