import { db } from '../db';
import { publish, RK } from '@lattice/queue';
import type { OtaDispatchPayload } from '@lattice/queue';
import { getChannel } from '../queue';
import { env } from '../config/env.config';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway:migration');

interface PinSlot {
  key: string;
}

export interface ActionPreview {
  id: number;
  name: string;
  mqttName: string;
  status: 'ok' | 'deprecated';
  reason?: string;
}

export interface UpdatePreview {
  current_version: string;
  new_version: string;
  actions: ActionPreview[];
}

function isCompatible(
  implType: string,
  existingPins: PinSlot[],
  blueprint: { implementation_type: string; configurable_pins: unknown },
): { compatible: boolean; reason?: string } {
  if (implType !== blueprint.implementation_type) {
    return { compatible: false, reason: 'implementation type changed' };
  }
  const newPins = (blueprint.configurable_pins as PinSlot[] | null) ?? [];
  if (existingPins.length !== newPins.length) {
    return { compatible: false, reason: 'pin count changed' };
  }
  for (let i = 0; i < existingPins.length; i++) {
    if (existingPins[i].key !== newPins[i].key) {
      return { compatible: false, reason: `pin slot "${existingPins[i].key}" renamed to "${newPins[i].key}"` };
    }
  }
  return { compatible: true };
}

async function resolveVersions(userDeviceId: number) {
  const userDevice = await db.userDevice.findUnique({
    where: { id: userDeviceId },
    include: { device: true },
  });
  if (!userDevice) throw Object.assign(new Error('Device not found'), { statusCode: 404 });

  const latest = await db.device.findFirst({
    where: { type: userDevice.device.type },
    orderBy: { created_at: 'desc' },
  });
  if (!latest) throw Object.assign(new Error('No catalog entry for this device type'), { statusCode: 500 });

  return { userDevice, currentDevice: userDevice.device, latestDevice: latest };
}

class ActionMigrationService {
  async previewUpdate(userDeviceId: number): Promise<UpdatePreview | { up_to_date: true }> {
    const { userDevice, currentDevice, latestDevice } = await resolveVersions(userDeviceId);

    if (currentDevice.id === latestDevice.id) {
      return { up_to_date: true };
    }

    const [blueprints, activeActions] = await Promise.all([
      db.deviceCapabilityBlueprint.findMany({
        where: { device_id: latestDevice.id },
      }),
      db.userDeviceAction.findMany({
        where: { user_device_id: userDeviceId, status: 'active' },
        include: { action: true },
      }),
    ]);

    const blueprintByMqttName = new Map(blueprints.map((b) => [b.mqtt_action_name, b]));

    const actions: ActionPreview[] = activeActions.map((ua) => {
      const bp = blueprintByMqttName.get(ua.action.mqtt_action_name ?? '');
      if (!bp) {
        return { id: ua.id, name: ua.action_name, mqttName: ua.mqtt_action_name, status: 'deprecated', reason: 'removed from new version' };
      }
      const existingPins = ((ua.action.pins ?? []) as unknown as PinSlot[]);
      const check = isCompatible(ua.action.implementation_type, existingPins, bp);
      return {
        id: ua.id,
        name: ua.action_name,
        mqttName: ua.mqtt_action_name,
        status: check.compatible ? 'ok' : 'deprecated',
        reason: check.compatible ? undefined : check.reason,
      };
    });

    return {
      current_version: currentDevice.version,
      new_version: latestDevice.version,
      actions,
    };
  }

  async applyUpdate(userDeviceId: number): Promise<void> {
    const { userDevice, currentDevice, latestDevice } = await resolveVersions(userDeviceId);

    if (currentDevice.id === latestDevice.id) return;

    const [blueprints, activeActions] = await Promise.all([
      db.deviceCapabilityBlueprint.findMany({ where: { device_id: latestDevice.id } }),
      db.userDeviceAction.findMany({
        where: { user_device_id: userDeviceId, status: 'active' },
        include: { action: true },
      }),
    ]);

    const blueprintByMqttName = new Map(blueprints.map((b) => [b.mqtt_action_name, b]));

    await db.$transaction(async (tx) => {
      for (const ua of activeActions) {
        const bp = blueprintByMqttName.get(ua.action.mqtt_action_name ?? '');
        if (!bp) {
          await tx.userDeviceAction.update({ where: { id: ua.id }, data: { status: 'deprecated' } });
          continue;
        }
        const existingPins = ((ua.action.pins ?? []) as unknown as PinSlot[]);
        const { compatible } = isCompatible(ua.action.implementation_type, existingPins, bp);
        if (!compatible) {
          await tx.userDeviceAction.update({ where: { id: ua.id }, data: { status: 'deprecated' } });
          continue;
        }

        // Upsert a DeviceAction template for the new device version.
        const newAction = await tx.deviceAction.upsert({
          where: { device_id_default_name: { device_id: latestDevice.id, default_name: bp.label } },
          update: {
            mqtt_action_name: bp.mqtt_action_name,
            mqtt_action_type: bp.mqtt_action_type,
            implementation_type: bp.implementation_type,
          },
          create: {
            device_id: latestDevice.id,
            default_name: bp.label,
            mqtt_action_name: bp.mqtt_action_name,
            mqtt_action_type: bp.mqtt_action_type,
            implementation_type: bp.implementation_type,
            telemetry_interval_ms: bp.min_telemetry_interval_ms ?? undefined,
          },
        });

        await tx.userDeviceAction.update({
          where: { id: ua.id },
          data: { action_id: newAction.id },
        });
      }

      await tx.userDevice.update({
        where: { id: userDeviceId },
        data: {
          device_type_id: latestDevice.id,
          current_firmware_version: latestDevice.version,
        },
      });
    });

    // Best-effort OTA dispatch — failure is logged but not fatal.
    try {
      const payload: OtaDispatchPayload = {
        deviceType: latestDevice.type,
        version: latestDevice.version,
        url: `${env.otaManagerUrl}/download/${latestDevice.type}/${latestDevice.version}`,
        timestamp: new Date().toISOString(),
      };
      publish(getChannel(), RK.OTA_DISPATCH, payload);
      log.info({ deviceType: latestDevice.type, version: latestDevice.version }, 'OTA dispatch sent');
    } catch (err) {
      log.warn({ err }, 'OTA dispatch failed — firmware will be picked up on next device reconnect');
    }
  }
}

export const actionMigrationService = new ActionMigrationService();
