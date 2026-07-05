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
  capability: { implementation_type: string; pins: PinSlot[] },
): { compatible: boolean; reason?: string } {
  if (implType !== capability.implementation_type) {
    return { compatible: false, reason: 'implementation type changed' };
  }
  const newPins = capability.pins ?? [];
  if (existingPins.length !== newPins.length) {
    return { compatible: false, reason: 'pin count changed' };
  }
  for (let i = 0; i < existingPins.length; i++) {
    if (existingPins[i].key !== newPins[i].key) {
      return {
        compatible: false,
        reason: `pin slot "${existingPins[i].key}" renamed to "${newPins[i].key}"`,
      };
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
  if (!latest)
    throw Object.assign(new Error('No catalog entry for this device type'), { statusCode: 500 });

  return { userDevice, currentDevice: userDevice.device, latestDevice: latest };
}

class ActionMigrationService {
  async previewUpdate(userDeviceId: number): Promise<UpdatePreview | { up_to_date: true }> {
    const { currentDevice, latestDevice } = await resolveVersions(userDeviceId);

    if (currentDevice.id === latestDevice.id) {
      return { up_to_date: true };
    }

    const [capabilities, activeActions] = await Promise.all([
      db.deviceCapability.findMany({
        where: { device_id: latestDevice.id },
        include: { pins: true },
      }),
      db.userDeviceAction.findMany({
        where: { user_device_id: userDeviceId, status: { in: ['active', 'staged_deprecated'] } },
        include: { capability: { include: { pins: true } } },
      }),
    ]);

    const capabilityByMqttName = new Map(capabilities.map((c) => [c.mqtt_action_name, c]));

    const actions: ActionPreview[] = activeActions.map((ua) => {
      const bp = capabilityByMqttName.get(ua.capability.mqtt_action_name ?? '');
      if (!bp) {
        return {
          id: ua.id,
          name: ua.action_name,
          mqttName: ua.mqtt_action_name,
          status: 'deprecated',
          reason: 'removed from new version',
        };
      }
      const existingPins = ua.capability.pins as PinSlot[];
      const check = isCompatible(ua.capability.implementation_type, existingPins, bp);
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
    const { currentDevice, latestDevice } = await resolveVersions(userDeviceId);

    if (currentDevice.id === latestDevice.id) return;

    log.info(
      { userDeviceId, from: currentDevice.version, to: latestDevice.version },
      'applying device action migration',
    );

    const [capabilities, activeActions] = await Promise.all([
      db.deviceCapability.findMany({
        where: { device_id: latestDevice.id },
        include: { pins: true },
      }),
      db.userDeviceAction.findMany({
        where: { user_device_id: userDeviceId, status: 'active' },
        include: { capability: { include: { pins: true } }, pins: true },
      }),
    ]);

    const capabilityByMqttName = new Map(capabilities.map((c) => [c.mqtt_action_name, c]));

    await db.$transaction(async (tx) => {
      // Clear any previous in-flight OTA staging before applying a new one.
      await tx.userDeviceAction.deleteMany({
        where: { user_device_id: userDeviceId, status: 'staged_active' },
      });
      await tx.userDeviceAction.updateMany({
        where: { user_device_id: userDeviceId, status: 'staged_deprecated' },
        data: { status: 'active' },
      });

      for (const ua of activeActions) {
        const bp = capabilityByMqttName.get(ua.capability.mqtt_action_name ?? '');
        if (!bp) {
          // Incompatible — stage for deprecation; leave active until OTA confirms.
          await tx.userDeviceAction.update({
            where: { id: ua.id },
            data: { status: 'staged_deprecated' },
          });
          continue;
        }
        const existingPins = ua.capability.pins as PinSlot[];
        const { compatible } = isCompatible(ua.capability.implementation_type, existingPins, bp);
        if (!compatible) {
          await tx.userDeviceAction.update({
            where: { id: ua.id },
            data: { status: 'staged_deprecated' },
          });
          continue;
        }

        // Create new action as staged_active, pointing at the new version's capability —
        // not yet live until the device confirms OTA. (No separate action template: the
        // DeviceCapability catalog row IS the per-version template since F1.5.)
        // Map old pin IDs → keys using the old capability's catalog pins,
        // then find the corresponding pin in the new capability by key.
        const oldPinIdToKey = new Map(ua.capability.pins.map((p) => [p.id, p.key]));
        const newKeyToPinId = new Map(bp.pins.map((p) => [p.key, p.id]));
        const migratedPins = ua.pins
          .map((p) => {
            const key = oldPinIdToKey.get(p.capability_pin_id);
            const newPinId = key !== undefined ? newKeyToPinId.get(key) : undefined;
            return newPinId !== undefined
              ? { capability_pin_id: newPinId, pin_number: p.pin_number }
              : null;
          })
          .filter((p): p is { capability_pin_id: number; pin_number: number } => p !== null);

        await tx.userDeviceAction.create({
          data: {
            user_device_id: userDeviceId,
            capability_id: bp.id,
            action_name: ua.action_name,
            mqtt_action_name: ua.mqtt_action_name,
            pins: { create: migratedPins },
            current_state: ua.current_state ?? undefined,
            status: 'staged_active',
            sort_order: ua.sort_order,
            group_id: ua.group_id ?? undefined,
            telemetry_interval_ms: ua.telemetry_interval_ms ?? undefined,
          },
        });
      }

      // Record pending firmware version — do NOT update current fields yet.
      await tx.userDevice.update({
        where: { id: userDeviceId },
        data: {
          pending_device_type_id: latestDevice.id,
          pending_firmware_version: latestDevice.version,
        },
      });
    });
    log.info(
      { userDeviceId, to: latestDevice.version, actionsStaged: activeActions.length },
      'device action migration staged',
    );

    // Best-effort OTA dispatch — failure is logged but not fatal.
    try {
      const payload: OtaDispatchPayload = {
        deviceType: latestDevice.type,
        version: latestDevice.version,
        url: `${env.otaManagerUrl}/download/${latestDevice.type}/${latestDevice.version}`,
        timestamp: new Date().toISOString(),
      };
      publish(getChannel(), RK.OTA_DISPATCH, payload);
      log.info(
        { deviceType: latestDevice.type, version: latestDevice.version },
        'OTA dispatch sent',
      );
    } catch (err) {
      log.warn(
        { err },
        'OTA dispatch failed — firmware will be picked up on next device reconnect',
      );
    }
  }
}

export const actionMigrationService = new ActionMigrationService();
