import db from '../config/db';
import { UserDevice, UserDeviceModel, UserActionDef, UserAction } from '@lattice/prisma-client';

export type UserDeviceWithModel = UserDevice & { device_model: UserDeviceModel };

class UserDevicesRepository {
  async getByUserId(userId: number): Promise<UserDeviceWithModel[]> {
    return db.userDevice.findMany({
      where: { user_id: userId },
      include: { device_model: true },
      orderBy: { created_at: 'asc' },
    });
  }

  async getById(id: number): Promise<UserDeviceWithModel> {
    return db.userDevice.findUniqueOrThrow({ where: { id }, include: { device_model: true } });
  }

  async getByMacId(macId: string): Promise<UserDeviceWithModel> {
    return db.userDevice.findUniqueOrThrow({ where: { mac_id: macId }, include: { device_model: true } });
  }

  /** Type-scoped: devices whose snapshot model has the given model_key. */
  async getByModelKeyForUser(userId: number, modelKey: string): Promise<UserDeviceWithModel[]> {
    return db.userDevice.findMany({
      where: { user_id: userId, device_model: { model_key: modelKey } },
      include: { device_model: true },
    });
  }

  /** Find an unbound placeholder (mac_id starts with 'unbound:'). */
  async getUnboundByModelKey(userId: number, modelKey: string): Promise<UserDevice | null> {
    return db.userDevice.findFirst({
      where: { user_id: userId, device_model: { model_key: modelKey }, mac_id: { startsWith: 'unbound:' } },
    });
  }

  async insert(data: {
    user_id: number;
    user_device_model_id: number;
    mac_id: string;
    name: string;
    source_blueprint_id?: number | null;
  }): Promise<UserDevice> {
    return db.userDevice.create({ data });
  }

  async bindPlaceholder(id: number, macId: string): Promise<UserDevice> {
    return db.userDevice.update({ where: { id }, data: { mac_id: macId, online: false, updated_at: new Date() } });
  }

  async updateOnlineStatus(id: number, online: boolean): Promise<void> {
    await db.userDevice.update({ where: { id }, data: { online, last_seen_at: new Date(), updated_at: new Date() } });
  }

  async update(userId: number, id: number, data: Partial<Pick<UserDevice, 'name'>>): Promise<UserDevice> {
    return db.userDevice.update({ where: { id, user_id: userId }, data: { ...data, updated_at: new Date() } });
  }

  async delete(id: number, userId: number): Promise<void> {
    await db.userDevice.delete({ where: { id, user_id: userId } });
  }

  /** Return UserActionDef rows for a device's model that have no active UserAction for that device yet. */
  async getPendingDefs(deviceId: number): Promise<UserActionDef[]> {
    const device = await db.userDevice.findUniqueOrThrow({
      where: { id: deviceId },
      select: { user_device_model_id: true },
    });
    return db.userActionDef.findMany({
      where: {
        user_device_model_id: device.user_device_model_id,
        actions: { none: { user_device_id: deviceId } },
      },
    });
  }

  /** Create UserAction rows for selected defs on a device. Returns the created rows. */
  async activateCapabilities(
    deviceId: number,
    items: { user_action_def_id: number; name: string; user_action_group_id?: number | null }[],
  ): Promise<UserAction[]> {
    return Promise.all(
      items.map((item, i) =>
        db.userAction.create({
          data: {
            user_device_id: deviceId,
            user_action_def_id: item.user_action_def_id,
            name: item.name,
            user_action_group_id: item.user_action_group_id ?? null,
            sort_order: i + 1,
          },
        }),
      ),
    );
  }
}

export const userDevicesRepository = new UserDevicesRepository();
