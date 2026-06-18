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
  async getConfigurationForDevice(userDeviceId: number): Promise<DeviceConfigurationDto> {
    const userDevice = await db.userDevice.findUnique({
      where: { id: userDeviceId },
      include: { device: true },
    });
    if (!userDevice) throw new Error('Device not found');

    const userActions = await db.userDeviceAction.findMany({
      where: { user_device_id: userDeviceId, status: 'active' },
      include: { action: true },
    });

    const actions: ActionConfigDto[] = userActions.map((ua) => ({
      mqtt_action_name:      ua.mqtt_action_name,
      implementation_type:   ua.action.implementation_type,
      mqtt_action_type:      ua.action.mqtt_action_type ?? 'command',
      pins:                  (ua.pins ?? ua.action.pins ?? []) as unknown as PinConfigDto[],
      telemetry_interval_ms: ua.telemetry_interval_ms ?? ua.action.telemetry_interval_ms ?? null,
    }));

    return { device_type: userDevice.device.type ?? '', device_version: userDevice.device.version, actions };
  }
}

export const deviceConfigurationService = new DeviceConfigurationService();
