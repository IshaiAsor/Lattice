import { GoogleActionTypeEntity, googleActionTypesRepository } from '../dal/google.action.types.repository';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { userDevicesRepository } from '../dal/user.devices.repository';
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
  state?: any;
  online?: boolean;
  sortOrder: number;
  status?: "active" | "deprecated";
  groupName: string | null;
}

class DeviceActionsService {

  async getUserActions(userId: number): Promise<DeviceActionView[]> {
    const [googleActionTypes, actions] = await Promise.all([
      googleActionTypesRepository.getAll(),
      userDevicesActionsRepository.getAllByUserId(userId),
    ]);
    return Promise.all(actions.map(async (a) => ({
      id: a.id,
      name: a.action_name,
      deviceName: a.user_device?.name ?? '',
      type: googleActionTypes.find((g) => g.id === a.action.google_type_id)?.name,
      googleType: googleActionTypes.find((g) => g.id === a.action.google_type_id),
      googleTraits: await googleActionsTraitsService.GetActionDefinitionTraits(a.action_id),
      actionName: a.action_name,
      implementation_type: a.action.implementation_type,
      state: a.current_state,
      deviceId: a.user_device_id,
      online: a.user_device?.online ?? false,
      sortOrder: a.sort_order,
      groupName: a.group_name ?? null,
      status: a.status as "active" | "deprecated",
    })));
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
      deviceName: device.name,
      type: googleActionType?.name,
      googleType: googleActionType,
      googleTraits: googleTraits,
      actionName: action.action_name,
      implementation_type: action.action.implementation_type,
      state: action.current_state,
      deviceId: action.user_device_id,
      online: device.online ?? false,
      sortOrder: action.sort_order,
      groupName: action.group_name ?? null,
      status: action.status as "active" | "deprecated",
    };
  }

  async updateAction(actionId: number, updates: { name?: string; group_name?: string | null }) {
    await userDevicesActionsRepository.updateAction(actionId, {
      ...(updates.name !== undefined && { action_name: updates.name }),
      ...(updates.group_name !== undefined && { group_name: updates.group_name }),
    });
  }

  async reorderActions(userId: number, orderedIds: number[]): Promise<void> {
    const userActions = await userDevicesActionsRepository.getAllByUserId(userId);
    const userActionIds = new Set(userActions.map((a) => a.id));
    if (orderedIds.some((id) => !userActionIds.has(id))) {
      const err = new Error('Forbidden') as any;
      err.status = 403;
      throw err;
    }
    await userDevicesActionsRepository.reorderActions(orderedIds);
  }

  async deleteAction(userId: number, actionId: number) {
    await userDevicesActionsRepository.deleteAction(actionId);
  }
}

export const deviceActionsService = new DeviceActionsService();