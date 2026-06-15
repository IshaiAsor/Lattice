import { userDevicesRepository } from '../dal/user.devices.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';

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
    const userDevice = await userDevicesRepository.getById(userDeviceId);
    const userActions = await userDevicesActionsRepository.getByDeviceId(userDeviceId);

    const actions: ActionConfigDto[] = userActions.map(ua => ({
      mqtt_action_name:      ua.mqtt_action_name,
      implementation_type:   ua.action.implementation_type,
      mqtt_action_type:      ua.action.mqtt_action_type ?? 'command',
      pins:                  (ua.pins ?? ua.action.pins ?? []) as unknown as PinConfigDto[],
      telemetry_interval_ms: (ua as any).telemetry_interval_ms ?? (ua.action as any).telemetry_interval_ms ?? null,
    }));

    return { device_type: userDevice.device.type ?? '', device_version: version, actions };
  }
}

export const deviceConfigurationService = new DeviceConfigurationService();
