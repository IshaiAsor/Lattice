import type { UserActionGroup } from '@lattice/prisma-client';
import { db } from '../db';

// Action groups are first-class entities (F2.6). The old monolith stored a free-text
// `group_name` on each action; now a group is a row and actions reference it by group_id
// (SetNull on delete, so deleting a group ungroups its actions rather than removing them).

class ActionGroupsService {
  async listGroups(userId: number): Promise<UserActionGroup[]> {
    // Remove empty groups that accumulated from previous rename/ungroup operations.
    await db.userActionGroup.deleteMany({
      where: { user_id: userId, actions: { none: {} } },
    });
    return db.userActionGroup.findMany({
      where: { user_id: userId },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  // Idempotent by (user, name): the dashboard assigns actions to a group *by name* and may
  // fire several concurrent assigns for the same group, so re-creating an existing group
  // returns it rather than erroring on the unique constraint.
  async createGroup(userId: number, name: string, sortOrder?: number): Promise<UserActionGroup> {
    if (typeof name !== 'string' || !name.trim()) {
      throw Object.assign(new Error('name is required'), { statusCode: 400 });
    }
    const trimmed = name.trim();
    await db.userActionGroup.deleteMany({
      where: { user_id: userId, actions: { none: {} } },
    });
    const existing = await db.userActionGroup.findUnique({
      where: { user_id_name: { user_id: userId, name: trimmed } },
    });
    if (existing) return existing;
    return db.userActionGroup.create({
      data: { user_id: userId, name: trimmed, sort_order: sortOrder ?? 0 },
    });
  }

  async updateGroup(
    userId: number,
    id: number,
    patch: { name?: string; sort_order?: number },
  ): Promise<UserActionGroup> {
    await this.ensureOwned(userId, id);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw Object.assign(new Error('name cannot be empty'), { statusCode: 400 });
    }
    if (patch.name !== undefined) {
      const conflict = await db.userActionGroup.findUnique({
        where: { user_id_name: { user_id: userId, name: patch.name.trim() } },
        select: { id: true },
      });
      if (conflict && conflict.id !== id) {
        throw Object.assign(new Error('A group with this name already exists'), { statusCode: 409 });
      }
    }
    return db.userActionGroup.update({
      where: { id },
      data: {
        name: patch.name?.trim(),
        sort_order: patch.sort_order,
        updated_at: new Date(),
      },
    });
  }

  async reorderGroups(userId: number, orderedIds: number[]): Promise<void> {
    const owned = new Set((await this.listGroups(userId)).map((g) => g.id));
    if (orderedIds.some((id) => !owned.has(id))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    await db.$transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx.userActionGroup.update({ where: { id }, data: { sort_order: index } });
      }
    });
  }

  // Creates or finds a group by name and assigns all given actions to it atomically.
  async assignActions(userId: number, name: string, actionIds: number[]): Promise<UserActionGroup> {
    if (typeof name !== 'string' || !name.trim()) {
      throw Object.assign(new Error('name is required'), { statusCode: 400 });
    }
    if (!Array.isArray(actionIds) || actionIds.length === 0) {
      throw Object.assign(new Error('actionIds must be a non-empty array'), { statusCode: 400 });
    }
    const trimmed = name.trim();

    // Verify all actions belong to this user.
    const owned = await db.userDeviceAction.findMany({
      where: { id: { in: actionIds }, user_device: { user_id: userId } },
      select: { id: true },
    });
    if (owned.length !== actionIds.length) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const group = await db.userActionGroup.findUnique({
      where: { user_id_name: { user_id: userId, name: trimmed } },
    }) ?? await db.userActionGroup.create({
      data: { user_id: userId, name: trimmed, sort_order: 0 },
    });

    await db.userDeviceAction.updateMany({
      where: { id: { in: actionIds } },
      data: { group_id: group.id, updated_at: new Date() },
    });

    return group;
  }

  async deleteGroup(userId: number, id: number): Promise<void> {
    await this.ensureOwned(userId, id);
    await db.userActionGroup.delete({ where: { id } }); // actions' group_id → null
  }

  private async ensureOwned(userId: number, id: number): Promise<void> {
    const group = await db.userActionGroup.findUnique({ where: { id }, select: { user_id: true } });
    if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
    if (group.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  }
}

export const actionGroupsService = new ActionGroupsService();
