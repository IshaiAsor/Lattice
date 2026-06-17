import { db } from '../db';

export interface PinConfigDto {
  pinNumber: number;
  pinMode: 'OUTPUT' | 'INPUT';
}

export interface ActionConfigDto {
  mqtt_action_name: string;
  implementation_type: string;
  mqtt_action_type: string;
  pins: PinConfigDto[];
  telemetry_interval_ms: number | null;
}

export interface DeviceConfigurationDto {
  device_type: string;
  device_version: string;
  actions: ActionConfigDto[];
}

class DeviceConfigurationService {
  async getConfigurationForDevice(userDeviceId: number, version: string): Promise<DeviceConfigurationDto> {
    const userDevice = await db.userDevice.findUnique({
      where: { id: userDeviceId },
      include: { device: true },
    });
    if (!userDevice) throw new Error('Device not found');

    const userActions = await db.userDeviceAction.findMany({
      where: { user_device_id: userDeviceId },
      include: { action: true },
    });

    if(userDevice.device.version !== version) {
      //todo : on v2.2 migrate device actions (after ota update) , get device new capabilities and update user actions accordingly (for now we just update device version, but in case of breaking changes in capabilities we need to update user actions as well)
      db.device.update({
        where: { id: userDevice.device_type_id },
        data: { version },
      });
    }


    const actions: ActionConfigDto[] = userActions.map((ua) => ({
      mqtt_action_name:      ua.mqtt_action_name,
      implementation_type:   ua.action.implementation_type,
      mqtt_action_type:      ua.action.mqtt_action_type ?? 'command',
      pins:                  (ua.pins ?? ua.action.pins ?? []) as unknown as PinConfigDto[],
      telemetry_interval_ms: ua.telemetry_interval_ms ?? ua.action.telemetry_interval_ms ?? null,
    }));

    return { device_type: userDevice.device.type ?? '', device_version: version, actions };
  }
}

export const deviceConfigurationService = new DeviceConfigurationService();
