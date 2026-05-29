import { userDevicesRepository } from '../dal/user.devices.repository';
import { deviceActionDefinitionRepository } from '../dal/device.actions.repository';
import { devicesRepository } from '../dal/devices';

export interface PinConfigDto {
  pinNumber: number;
  pinMode: 'OUTPUT' | 'INPUT';
}

export interface ValidParametersDto {
  values: string[];
  range?: { min: number; max: number };
}

export interface ActionConfigDto {
  mqtt_action_name: string;
  implementation_type: string;
  mqtt_action_type: string;
  valid_parameters: ValidParametersDto;
  pins: PinConfigDto[];
}

export interface DeviceConfigurationDto {
  device_type: string;
  device_version: string;
  actions: ActionConfigDto[];
}

class DeviceConfigurationService {
  // userDeviceId: from JWT clientid — identifies the registered device (determines device type)
  // version: from URL path — selects which version's action config to return
  async getConfigurationForDevice(userDeviceId: number, version: string): Promise<DeviceConfigurationDto> {
    const userDevice = await userDevicesRepository.getById(userDeviceId);
    const deviceType = userDevice.device.type ?? '';

    // Look up the Device template by (type, version) — allows serving different configs per version
    const device = await devicesRepository.GetByType(deviceType, version);
    const deviceActions = await deviceActionDefinitionRepository.Get(device.id);

    const actions: ActionConfigDto[] = deviceActions.map(da => ({
      mqtt_action_name:    da.mqtt_action_name ?? da.default_name,
      implementation_type: (da as any).implementation_type,
      mqtt_action_type:    da.mqtt_action_type ?? 'command',
      valid_parameters:    ((da as any).valid_parameters ?? { values: [] }) as ValidParametersDto,
      pins:                ((da as any).pins ?? []) as PinConfigDto[],
    }));

    return {
      device_type:    deviceType,
      device_version: version,
      actions,
    };
  }
}

export const deviceConfigurationService = new DeviceConfigurationService();
