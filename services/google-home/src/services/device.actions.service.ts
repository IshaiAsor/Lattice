import { deriveValidParameters } from '@lattice/capability-validation';
import { googleActionTypesRepository, GoogleActionTypeEntity } from '../dal/google.action.types.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { googleActionsTraitsService, GoogleActionTraitView } from './google.actions.traits.service';

export interface DeviceActionView {
  id: number;
  deviceId: number;
  deviceName: string;
  name: string;
  type?: string;
  googleType?: GoogleActionTypeEntity;
  googleTraits: GoogleActionTraitView[];
  actionName: string;
  implementation_type: string;
  validParameters?: unknown;
  state?: any;
  online?: boolean;
  sortOrder: number;
  groupName: string | null;
}

class DeviceActionsService {
  async getUserActions(userId: number): Promise<DeviceActionView[]> {
    const [googleActionTypes, actions] = await Promise.all([
      googleActionTypesRepository.getAll(),
      userDevicesActionsRepository.getAllByUserId(userId),
    ]);
    return Promise.all(actions.map(async (a) => {
      const googleTraits = await googleActionsTraitsService.GetActionDefinitionTraits(a.capability_id);
      return {
        id: a.id,
        name: a.action_name,
        deviceName: a.user_device?.name ?? '',
        type: googleActionTypes.find((g) => g.id === a.capability.google_type_id)?.name,
        googleType: googleActionTypes.find((g) => g.id === a.capability.google_type_id),
        googleTraits,
        actionName: a.action_name,
        implementation_type: a.capability.implementation_type,
        validParameters: deriveValidParameters(googleTraits.map((t) => t.validParameters)),
        state: a.current_state,
        deviceId: a.user_device_id,
        online: a.user_device?.online ?? false,
        sortOrder: a.sort_order,
        groupName: a.group?.name ?? null,
      };
    }));
  }

  async getActionByDeviceAndName(deviceId: number, actionName: string): Promise<DeviceActionView | null> {
    const [googleActionTypes, action] = await Promise.all([
      googleActionTypesRepository.getAll(),
      userDevicesActionsRepository.getByDeviceAndActionName(deviceId, actionName),
    ]);
    if (!action) return null;
    const googleTraits = await googleActionsTraitsService.GetActionDefinitionTraits(action.capability_id);
    return {
      id: action.id,
      name: action.action_name,
      deviceName: '',
      type: googleActionTypes.find((g) => g.id === action.capability.google_type_id)?.name,
      googleType: googleActionTypes.find((g) => g.id === action.capability.google_type_id),
      googleTraits,
      actionName: action.action_name,
      implementation_type: action.capability.implementation_type,
      validParameters: deriveValidParameters(googleTraits.map((t) => t.validParameters)),
      state: action.current_state,
      deviceId: action.user_device_id,
      online: false,
      sortOrder: action.sort_order,
      groupName: action.group?.name ?? null,
    };
  }
}

export const deviceActionsService = new DeviceActionsService();
