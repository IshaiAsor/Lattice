import { db } from '../db';
import { jwtService, JwtPurpose } from './jwt.service';
import { env } from '../config/env.config';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway');

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

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
  // Device-facing single call. The catalog (device type + capability blueprints) is no
  // longer written here — it is published from firmware source by the manifest generator
  // (locally `npm run catalog:seed`, in prod the CI ingest). Provisioning only VALIDATES
  // the firmware's (type, version) against that catalog, then binds the user_device.
  async provisionDevice(
    userId: number,
    macAddress: string,
    deviceType: string,
    version: string,
    capabilities: CapabilityInput[],
  ) {
    // 1. The firmware's (type, version) must already exist in the catalog.
    log.debug({ userId, macAddress, deviceType, version, capabilities }, 'provisioning device');
    const device = await db.device.findUnique({
      where: { type_version: { type: deviceType, version } },
    });
    if (!device) {
      throw new HttpError(
        409,
        `Unknown firmware (type=${deviceType}, version=${version}) — not in device catalog. ` +
          `Publish its manifest first (local: npm run catalog:seed; prod: CI manifest ingest).`,
      );
    }

    // 2. Upsert user_device by mac_id.
    const userDevice = await db.userDevice.upsert({
      where: { mac_id: macAddress },
      update: { user_id: userId, device_type_id: device.id },
      create: { user_id: userId, device_type_id: device.id, mac_id: macAddress, name: deviceType },
    });

    // 4. Return permanent JWT + URLs.
    const tokenData = this.generatePermanentToken(userId, userDevice.id, version);
    log.debug({ userId, macAddress, deviceType, version, tokenData }, 'provisioned device');
    return tokenData;
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
