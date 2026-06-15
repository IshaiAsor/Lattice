import db from '../config/db';
import { UserDeviceAction, DeviceAction, UserDevice, Prisma } from '@prisma/client';

export type UserDeviceActionWithAction = UserDeviceAction & { action: DeviceAction };
export type UserDeviceActionWithActionAndDevice = UserDeviceAction & { action: DeviceAction; user_device: UserDevice };

class UserDevicesActionsRepository {

  async updateState(id: number, state: any) {
    await db.userDeviceAction.update({
      where: { id },
      data: { current_state: state, updated_at: new Date() },
    });
  }

  async getByDeviceId(deviceId: number): Promise<UserDeviceActionWithAction[]> {
    return db.userDeviceAction.findMany({
      where: { user_device_id: deviceId },
      include: { action: true },
    }) as Promise<UserDeviceActionWithAction[]>;
  }

  async getAllByUserId(userId: number): Promise<UserDeviceActionWithActionAndDevice[]> {
    return db.userDeviceAction.findMany({
      where: { user_device: { user_id: userId } },
      include: { action: true, user_device: true },
      orderBy: { sort_order: 'asc' },
    }) as Promise<UserDeviceActionWithActionAndDevice[]>;
  }

  async reorderActions(orderedIds: number[]): Promise<void> {
    await db.$transaction(
      orderedIds.map((id, index) =>
        db.userDeviceAction.update({ where: { id }, data: { sort_order: index + 1 } })
      )
    );
  }

  async insertAction(action: Pick<UserDeviceAction, 'user_device_id' | 'action_id' | 'action_name' | 'mqtt_action_name'> & { current_state?: string | null }) {
    return db.userDeviceAction.create({
      data: {
        user_device_id: action.user_device_id,
        action_id: action.action_id,
        action_name: action.action_name,
        mqtt_action_name: action.mqtt_action_name,
        current_state: action.current_state,
      },
    });
  }

  async deleteAction(actionId: number) {
    return db.userDeviceAction.delete({ where: { id: actionId } });
  }

  async getById(actionId: number): Promise<UserDeviceActionWithAction | null> {
    return db.userDeviceAction.findFirst({
      where: { id: actionId },
      include: { action: true },
    }) as Promise<UserDeviceActionWithAction | null>;
  }

  async updateAction(id: number, updates: {
    action_name?: string;
    mqtt_action_name?: string;
    pins?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    current_state?: string | null;
    telemetry_interval_ms?: number | null;
    sort_order?: number;
    group_name?: string | null;
  }) {
    return db.userDeviceAction.update({
      where: { id },
      data: { ...updates, updated_at: new Date() },
    });
  }
}

export const userDevicesActionsRepository = new UserDevicesActionsRepository();
