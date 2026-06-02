import { userDevicesRepository } from '../dal/user.devices.repository';
import { deviceActionDefinitionRepository } from '../dal/device.actions.repository';
import { devicesRepository } from '../dal/devices';

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
    const deviceType = userDevice.device.type ?? '';

    const device = await devicesRepository.GetByType(deviceType, version);
    const deviceActions = await deviceActionDefinitionRepository.Get(device.id);

    const actions: ActionConfigDto[] = deviceActions.map(da => ({
      mqtt_action_name:      da.mqtt_action_name ?? da.default_name,
      implementation_type:   da.implementation_type,
      mqtt_action_type:      da.mqtt_action_type ?? 'command',
      pins:                  (da.pins ?? []) as unknown as PinConfigDto[],
      telemetry_interval_ms: (da as any).telemetry_interval_ms ?? null,
    }));

    return { device_type: deviceType, device_version: version, actions };
  }
}

export const deviceConfigurationService = new DeviceConfigurationService();
