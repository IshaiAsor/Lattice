import { db } from '../db';
import { jwtService, JwtPurpose } from './jwt.service';
import { env } from '../config/env.config';
import { createLogger } from '@lattice/logger';
import { materializeForUserDevice } from './sealed-materialization.service';

const log = createLogger('device-gateway');

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
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
  google_traits?: { value: string; label: string; constraint?: unknown }[] | null;
}

class ProvisioningService {
  // Device-facing single call. The catalog (device type + capabilities) is no
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
    log.info({ userId, macAddress, deviceType, version, capabilities }, 'provisioning device');
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

    // 2. The firmware's own manifest is authoritative about what the hardware can do; the catalog
    // is what every other service reads. They are published from the same source, so a mismatch
    // means the seeded manifest is stale or the wrong build was flashed — surface it here, where
    // the two are side by side, rather than letting it show up later as a missing capability.
    await this.warnOnCapabilityDrift(device.id, deviceType, version, capabilities);

    // 3. Upsert user_device by mac_id. `status` is set on create only — a re-provision (factory
    // reset, firmware update) must not drag an already-configured device back into setup.
    const userDevice = await db.userDevice.upsert({
      where: { mac_id: macAddress },
      update: { user_id: userId, device_type_id: device.id },
      create: {
        user_id: userId,
        device_type_id: device.id,
        mac_id: macAddress,
        name: deviceType,
        status: 'provisioning',
      },
    });

    // 4. Sealed devices are factory-soldered: their config is admin-composed, not user-chosen —
    // auto-materialize the resolved template's actions/pins/behaviors so the device pulls a full
    // config with no user setup. Regular devices materialize nothing here (user configures later).
    if (device.is_sealed) {
      try {
        await materializeForUserDevice(userDevice.id);
        // There is no user-facing setup for a sealed device, so it is done the moment its
        // template lands. Only on success: a failed materialization leaves it in setup so the
        // device shows as needing attention instead of silently claiming to be configured.
        if (userDevice.status !== 'active') {
          await db.userDevice.update({ where: { id: userDevice.id }, data: { status: 'active' } });
        }
      } catch (err) {
        log.warn(
          { err, userDeviceId: userDevice.id },
          'sealed materialization failed — device will retry on config pull',
        );
      }
    }

    // 5. Return permanent JWT + URLs.
    const tokenData = this.generatePermanentToken(userId, userDevice.id, version);
    log.info(
      { userId, macAddress, deviceType, version, userDeviceId: userDevice.id },
      'provisioned device',
    );
    return tokenData;
  }

  // Compare what the firmware says it can do against what the catalog says it can do. Diagnostic
  // only — the catalog stays authoritative and a device never authors catalog rows, so drift is
  // logged rather than reconciled. Both sides are keyed by capability_key, the same identity OTA
  // uses to carry actions across a firmware update.
  private async warnOnCapabilityDrift(
    deviceId: number,
    deviceType: string,
    version: string,
    capabilities: CapabilityInput[],
  ): Promise<void> {
    if (!capabilities.length) return;

    const catalog = await db.deviceCapability.findMany({
      where: { device_id: deviceId },
      select: { capability_key: true },
    });

    const catalogKeys = new Set(catalog.map((c) => c.capability_key));
    const declaredKeys = new Set(capabilities.map((c) => c.capability_key));

    const missingFromCatalog = [...declaredKeys].filter((k) => !catalogKeys.has(k));
    const missingFromFirmware = [...catalogKeys].filter((k) => !declaredKeys.has(k));

    if (missingFromCatalog.length || missingFromFirmware.length) {
      log.warn(
        { deviceType, version, missingFromCatalog, missingFromFirmware },
        'capability drift: the flashed firmware and the seeded catalog disagree — ' +
          'republish this version’s manifest (local: npm run catalog:seed; prod: CI manifest ingest)',
      );
    }
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
