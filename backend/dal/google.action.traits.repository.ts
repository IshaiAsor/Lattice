import db from '../config/db';

interface GoogleTraitTypeEntity {
  id: number;
  name: string;
  value: string;
  valid_parameters: string[];
  created_at: Date;
}

class GoogleTraitsRepository {
  async getById(traitId: number):Promise<GoogleTraitTypeEntity|null> {
    let result = await db.query<GoogleTraitTypeEntity>('SELECT * FROM google_device_traits WHERE id = $1', [traitId]);

    if (result.rows.length === 0)
      return null;
    else
      return result.rows[0];
  }

  async getAll():Promise<GoogleTraitTypeEntity[]|null> {
    const result = await db.query<GoogleTraitTypeEntity>('SELECT * FROM google_device_traits');
    return result.rows;
  }
}

export const googleTraitsRepository = new GoogleTraitsRepository();
