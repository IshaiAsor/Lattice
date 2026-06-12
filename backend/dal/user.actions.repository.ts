import db from '../config/db';
import { UserAction, UserActionDef, UserDevice } from '@lattice/prisma-client';

export type UserActionWithDef = UserAction & { action_def: UserActionDef };
export type UserActionWithDefAndDevice = UserAction & { action_def: UserActionDef; user_device: UserDevice };

class UserActionsRepository {
  async updateState(id: number, state: string): Promise<void> {
    await db.userAction.update({ where: { id }, data: { state, updated_at: new Date() } });
  }

  async getByDeviceId(userDeviceId: number): Promise<UserActionWithDef[]> {
    return db.userAction.findMany({
      where: { user_device_id: userDeviceId },
      include: { action_def: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async getAllByUserId(userId: number): Promise<UserActionWithDefAndDevice[]> {
    return db.userAction.findMany({
      where: { user_device: { user_id: userId } },
      include: { action_def: true, user_device: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  /** Type-scoped: all actions whose definition has the given capability string. */
  async getByCapabilityForUser(userId: number, capability: string): Promise<UserActionWithDefAndDevice[]> {
    return db.userAction.findMany({
      where: { user_device: { user_id: userId }, action_def: { capability } },
      include: { action_def: true, user_device: true },
    });
  }

  /** Group-scoped: all actions belonging to a user action group. */
  async getByGroupId(groupId: number): Promise<UserActionWithDef[]> {
    return db.userAction.findMany({
      where: { user_action_group_id: groupId },
      include: { action_def: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async reorder(orderedIds: number[]): Promise<void> {
    await db.$transaction(
      orderedIds.map((id, i) =>
        db.userAction.update({ where: { id }, data: { sort_order: i + 1 } }),
      ),
    );
  }

  async insert(data: { user_device_id: number; user_action_def_id: number; name: string; state?: string | null }): Promise<UserAction> {
    return db.userAction.create({ data });
  }

  async getById(id: number): Promise<UserActionWithDef | null> {
    return db.userAction.findFirst({ where: { id }, include: { action_def: true } });
  }

  async patch(id: number, updates: Partial<Pick<UserAction, 'name' | 'user_action_group_id' | 'sort_order'>>): Promise<UserAction> {
    return db.userAction.update({ where: { id }, data: { ...updates, updated_at: new Date() } });
  }

  async delete(id: number): Promise<void> {
    await db.userAction.delete({ where: { id } });
  }
}

export const userActionsRepository = new UserActionsRepository();
