import db from '../config/db';
import { Device } from '@prisma/client';

export type { Device };

class DevicesRepository {
  async GetAll(): Promise<Device[]> {
    return db.device.findMany();
  }

  async GetById(id: number): Promise<Device | null> {
    return db.device.findUnique({ where: { id } });
  }

  async GetByType(type: string, version: string): Promise<Device> {
    return db.device.findFirstOrThrow({ where: { type, version } });
  }

  async Insert(type: string, version: string, default_name: string): Promise<Device> {
    return db.device.create({ data: { type, version, default_name } });
  }

  async Update(id: number, fields: Partial<Pick<Device, 'type' | 'version' | 'default_name'>>): Promise<Device> {
    return db.device.update({ where: { id }, data: fields });
  }

  async Delete(id: number): Promise<void> {
    await db.device.delete({ where: { id } });
  }
}

export const devicesRepository = new DevicesRepository();
