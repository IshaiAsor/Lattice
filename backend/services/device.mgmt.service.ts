import { userDevicesRepository } from '../dal/user.devices.repository';
import { deviceStatusEnum } from '../common/deviceStatusEnum';
import { devicesRepository } from '../dal/devices';
import { deviceActionDefinitionRepository } from '../dal/device.actions.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';

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
    deviceId: number,
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

    for (let actionDef of deviceActions) {
      await userDevicesActionsRepository.insertAction({
        user_device_id: newDevice.id,
        action_name: actionDef.default_name,
        action_id: actionDef.id,
      });
    }
    return newDevice;
  }

  async getUserDevices(userId: number): Promise<DeviceView[]> {
    var devices = await userDevicesRepository.getUserDevices(userId);

    return devices.map((device) => {
      return {
        id: device.id,
        deviceName: device.name,
        online: device.online,
        lastOnlineDate: device.last_online_date,
        type: device.type,
        version: device.version,
      };
    });
  }

  async updateDevice(userId: number, deviceId: number, updates: Partial<DeviceView>) {
    const device = await userDevicesRepository.updateDevice(userId, deviceId, updates);
    return device;
  }

  async deleteDevice(userId: number, deviceId: number) {
    await userDevicesRepository.deleteDevice(deviceId, userId);
  }
}
export const deviceMgmtService = new DeviceMgmtService();
