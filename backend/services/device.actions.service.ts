import { GoogleActionTypeEntity, googleActionTypesRepository } from '../dal/google.action.types.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { userDevicesRepository } from '../dal/user.devices.repository';
import { googleActionsTraitsService, GoogleActionTraitView } from './google.actions.traits.service';

export interface DeviceActionView {
  id: number;
  deviceId: number;
  name: string;
  type?: string;
  googleType?:GoogleActionTypeEntity;
  googleTraits: GoogleActionTraitView[];
  actionName: string;
  state?: any;
  online?: boolean;
}

class DeviceActionsService {

  async getUserActions(userId: number): Promise<DeviceActionView[]> {
    const googleActionTypes = await googleActionTypesRepository.getAll();
    const userDevices = await userDevicesRepository.getUserDevices(userId);
    const actionsp = await Promise.all(userDevices.map(async (device: any) => {
      const actions = await userDevicesActionsRepository.getByDeviceId(device.id);
      return Promise.all(actions.map<Promise<DeviceActionView>>(async (a: any) => ({
        id: a.id,
        name: a.action_name,
        type: googleActionTypes.find((g: any) => g.id === a.action.google_type_id)?.name,
        googleType: googleActionTypes.find((g: any) => g.id === a.action.google_type_id),
        googleTraits: await googleActionsTraitsService.GetActionDefinitionTraits(a.action_id) ,
        actionName: a.action_name,
        state: a.current_state,
        deviceId: a.user_device_id,
        online: device.online ?? false
      })));
    }));

    return actionsp.flat();
  }

  async getActionView(actionId: number): Promise<DeviceActionView | null> {
    const action = await userDevicesActionsRepository.getById(actionId);
    if (!action) {
      return null;
    }
    const device = await userDevicesRepository.getById(action.user_device_id);
    if (!device) {
      return null;
    }
    const googleActionTypes = await googleActionTypesRepository.getAll();
    const googleActionType = googleActionTypes.find(t => t.id === action.action.google_type_id);
    const googleTraits = await googleActionsTraitsService.GetActionDefinitionTraits(action.action_id);

    return {
      id: action.id,
      name: action.action_name,
      type: googleActionType?.name,
      googleType: googleActionType,
      googleTraits: googleTraits,
      actionName: action.action_name,
      state: action.current_state,
      deviceId: action.user_device_id,
      online: device.online ?? false
    };
  }

  async updateAction(actionId: number, updates: { name?: string }) {
    await userDevicesActionsRepository.updateAction(actionId, {
      ...(updates.name !== undefined && { action_name: updates.name }),
    });
  }

  async deleteAction(userId: number, actionId: number) {
    await userDevicesActionsRepository.deleteAction(actionId);
  }
}

export const deviceActionsService = new DeviceActionsService();