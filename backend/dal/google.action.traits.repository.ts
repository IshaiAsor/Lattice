import db from '../config/db';
import { GoogleDeviceTrait } from '@prisma/client';

export type GoogleTraitTypeEntity = GoogleDeviceTrait;

class GoogleTraitsRepository {
  async getById(traitId: number): Promise<GoogleTraitTypeEntity | null> {
    return db.googleDeviceTrait.findUnique({ where: { id: traitId } });
  }

  async getAll(): Promise<GoogleTraitTypeEntity[]> {
    return db.googleDeviceTrait.findMany();
  }

  async upsertTraitsForAction(deviceActionId: number, traitIds: number[]): Promise<void> {
    await db.actionTypeTrait.deleteMany({ where: { device_action_type_id: deviceActionId } });
    if (traitIds.length > 0) {
      await db.actionTypeTrait.createMany({
        data: traitIds.map((google_trait_id) => ({ device_action_type_id: deviceActionId, google_trait_id })),
        skipDuplicates: true,
      });
    }
  }
}

export const googleTraitsRepository = new GoogleTraitsRepository();
