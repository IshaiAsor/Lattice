import { userDevicesRepository } from '../dal/user.devices.repository';
import { devicesRepository } from '../dal/devices';
import { deviceActionDefinitionRepository } from '../dal/device.actions.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { blueprintsRepository } from '../dal/blueprints.repository';
import { googleActionTypesRepository } from '../dal/google.action.types.repository';
import { googleTraitsRepository } from '../dal/google.action.traits.repository';
import commandDispatch from './command.dispatch.service';
import db from '../config/db';
import { Prisma } from '@prisma/client';

export interface PinSlot {
  key: string;
  label: string;
  mode: string;
}

export interface BlueprintInstanceView {
  id: number;
  name: string;
  mqttName: string;
  pins: { pinNumber: number; pinMode: string }[] | null;
  intervalMs: number | null;
}

export interface BlueprintView {
  id: number;
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  min_telemetry_interval_ms: number | null;
  configurable_pins: PinSlot[];
  instances: BlueprintInstanceView[];
}

export interface DeviceView {
  id: number;
  deviceName: string;
  online?: boolean;
  lastOnlineDate?: Date;
  type: string;
  version: string;
}

class DeviceMgmtService {
  async registerUserDevice(
    userId: number,
    provisioningToken: string,
    deviceType: string,
    deviceId: string,
    macAddress: string,
    version: string,
  ) {
    let deviceDefinition = await devicesRepository.GetByType(deviceType, version);
    let deviceActions = await deviceActionDefinitionRepository.Get(deviceDefinition.id);

    let newDevice = await userDevicesRepository.insertDevice({
      device_type_id: deviceDefinition.id,
      user_id: userId,
      mac_id: macAddress,
      name: deviceType,
      type: deviceType,
    });

    const actionPromises = deviceActions.map(actionDef =>
      userDevicesActionsRepository.insertAction({
        user_device_id: newDevice.id,
        action_id: actionDef.id,
        action_name: actionDef.default_name,
        mqtt_action_name: actionDef.mqtt_action_name ?? actionDef.default_name,
      })
    );
    await Promise.all(actionPromises);

    return newDevice;
  }

  async getUserDevices(userId: number): Promise<DeviceView[]> {
    const devices = await userDevicesRepository.getUserDevices(userId);

    return devices.map((device: any) => {
      return {
        id: device.id,
        deviceName: device.name,
        online: device.online || false,
        lastOnlineDate: device.last_online_date || undefined,
        type: device.device.type || '',
        version: device.device.version || '',
      };
    });
  }

  async updateDevice(userId: number, deviceId: number, updates: Partial<DeviceView>) {
    const device = await userDevicesRepository.updateDevice(userId, deviceId, updates);
    return device;
  }

  async getDeviceBlueprints(userId: number, userDeviceId: number): Promise<BlueprintView[]> {
    const userDevice = await userDevicesRepository.getById(userDeviceId);
    if (userDevice.user_id !== userId) throw Object.assign(new Error('Forbidden'), { status: 403 });

    const [blueprints, userActions] = await Promise.all([
      blueprintsRepository.getByDeviceTypeId(userDevice.device_type_id),
      userDevicesActionsRepository.getByDeviceId(userDeviceId),
    ]);

    return blueprints.map(bp => {
      const matches = userActions.filter(
        ua => ua.action.mqtt_action_name === bp.mqtt_action_name &&
              ua.action.mqtt_action_type === bp.mqtt_action_type
      );
      return {
        id: bp.id,
        capability_key: bp.capability_key,
        label: bp.label,
        implementation_type: bp.implementation_type,
        mqtt_action_type: bp.mqtt_action_type,
        mqtt_action_name: bp.mqtt_action_name,
        min_telemetry_interval_ms: bp.min_telemetry_interval_ms,
        configurable_pins: (bp.configurable_pins as any) ?? [],
        instances: matches.map(ua => ({
          id: ua.id,
          name: ua.action_name,
          mqttName: ua.mqtt_action_name,
          pins: (ua.pins ?? ua.action.pins ?? null) as { pinNumber: number; pinMode: string }[] | null,
          intervalMs: ua.telemetry_interval_ms ?? null,
        })),
      };
    });
  }

  async activateBlueprintAction(
    userId: number,
    userDeviceId: number,
    blueprintId: number,
    telemetryIntervalMs?: number | null,
    pins?: { pinNumber: number; pinMode: string }[],
  ) {
    const userDevice = await userDevicesRepository.getById(userDeviceId);
    if (userDevice.user_id !== userId) throw Object.assign(new Error('Forbidden'), { status: 403 });

    const blueprint = await blueprintsRepository.getById(blueprintId);
    if (!blueprint) throw Object.assign(new Error('Blueprint not found'), { status: 404 });

    const [allTypes, allTraits] = await Promise.all([
      googleActionTypesRepository.getAll(),
      googleTraitsRepository.getAll(),
    ]);

    const googleTypeId = blueprint.google_action_type
      ? (allTypes.find(t => t.value === blueprint.google_action_type)?.id ?? null)
      : null;

    const blueprintTraitValues = (blueprint.google_traits as string[] | null) ?? [];
    const traitIds = blueprintTraitValues
      .map(v => allTraits.find(t => t.value === v)?.id)
      .filter((id): id is number => id !== undefined);

    // Upsert DeviceAction as a type template only (no pins — those live on the instance)
    const deviceAction = await db.deviceAction.upsert({
      where: { device_id_default_name: { device_id: blueprint.device_id, default_name: blueprint.label } },
      update: {
        mqtt_action_name: blueprint.mqtt_action_name,
        mqtt_action_type: blueprint.mqtt_action_type,
        implementation_type: blueprint.implementation_type,
        google_type_id: googleTypeId,
        telemetry_interval_ms: blueprint.min_telemetry_interval_ms ?? undefined,
      },
      create: {
        device_id: blueprint.device_id,
        default_name: blueprint.label,
        mqtt_action_name: blueprint.mqtt_action_name,
        mqtt_action_type: blueprint.mqtt_action_type,
        implementation_type: blueprint.implementation_type,
        google_type_id: googleTypeId,
        telemetry_interval_ms: blueprint.min_telemetry_interval_ms ?? undefined,
      },
    });

    if (traitIds.length > 0) {
      await db.actionTypeTrait.deleteMany({ where: { device_action_type_id: deviceAction.id } });
      await db.actionTypeTrait.createMany({
        data: traitIds.map(traitId => ({
          device_action_type_id: deviceAction.id,
          google_trait_id: traitId,
        })),
        skipDuplicates: true,
      });
    }

    // Auto-generate a unique MQTT name per instance
    const existingCount = await db.userDeviceAction.count({
      where: { user_device_id: userDeviceId, action_id: deviceAction.id },
    });
    const instanceMqttName = existingCount === 0
      ? blueprint.mqtt_action_name
      : `${blueprint.mqtt_action_name}_${existingCount + 1}`;

    const userAction = await db.userDeviceAction.create({
      data: {
        user_device_id: userDeviceId,
        action_id: deviceAction.id,
        action_name: blueprint.label,
        mqtt_action_name: instanceMqttName,
        pins: pins ? (pins as any) : null,
        telemetry_interval_ms: telemetryIntervalMs ?? null,
      },
    });

    return userAction;
  }

  async updateBlueprintAction(
    userId: number,
    userDeviceId: number,
    userActionId: number,
    updates: { name?: string; telemetryIntervalMs?: number | null; pins?: { pinNumber: number; pinMode: string }[] },
  ) {
    const userDevice = await userDevicesRepository.getById(userDeviceId);
    if (userDevice.user_id !== userId) throw Object.assign(new Error('Forbidden'), { status: 403 });

    const userAction = await userDevicesActionsRepository.getById(userActionId);
    if (!userAction || userAction.user_device_id !== userDeviceId) throw Object.assign(new Error('Not found'), { status: 404 });

    await userDevicesActionsRepository.updateAction(userActionId, {
      ...(updates.name !== undefined && { action_name: updates.name }),
      ...(updates.telemetryIntervalMs !== undefined && { telemetry_interval_ms: updates.telemetryIntervalMs }),
      ...(updates.pins !== undefined && { pins: updates.pins as Prisma.InputJsonValue }),
    });
  }

  async deleteDevice(userId: number, deviceId: number) {
    try {
      await commandDispatch.publishCommand(userId, deviceId, 'hard-reset', '');
    } catch (err) {
      console.warn(`[DeviceMgmt] Could not send hard-reset before deleting device ${deviceId}:`, err);
    }
    await userDevicesRepository.deleteDevice(deviceId, userId);
  }
}
export const deviceMgmtService = new DeviceMgmtService();
