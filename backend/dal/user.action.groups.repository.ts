import db from '../config/db';
import { UserActionGroup } from '@lattice/prisma-client';

export type CreateUserActionGroupInput = {
  user_device_id: number;
  user_id: number;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  sort_order?: number;
  source_blueprint_id?: number | null;
};

class UserActionGroupsRepository {
  async getByUserId(userId: number): Promise<(UserActionGroup & { actions: { id: number; name: string }[] })[]> {
    return db.userActionGroup.findMany({
      where: { user_id: userId },
      include: { actions: { select: { id: true, name: true } } },
      orderBy: { sort_order: 'asc' },
    }) as any;
  }

  async getById(id: number, userId: number): Promise<UserActionGroup | null> {
    return db.userActionGroup.findFirst({ where: { id, user_id: userId } });
  }

  async create(data: CreateUserActionGroupInput): Promise<UserActionGroup> {
    return db.userActionGroup.create({ data });
  }

  async update(id: number, userId: number, data: Partial<Omit<CreateUserActionGroupInput, 'user_id' | 'user_device_id'>>): Promise<UserActionGroup> {
    return db.userActionGroup.update({ where: { id, user_id: userId }, data });
  }

  async delete(id: number, userId: number): Promise<void> {
    await db.userActionGroup.deleteMany({ where: { id, user_id: userId } });
  }

  async reorder(userId: number, orderedIds: number[]): Promise<void> {
    await db.$transaction(
      orderedIds.map((id, i) =>
        db.userActionGroup.updateMany({ where: { id, user_id: userId }, data: { sort_order: i + 1 } }),
      ),
    );
  }
}

export const userActionGroupsRepository = new UserActionGroupsRepository();
