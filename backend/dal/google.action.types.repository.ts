import db from '../config/db';

export interface GoogleActionTypeEntity {
  id: number;
  name: string;
  value: string;
  created_at: Date;
}

class GoogleActionTypesRepository {
  async getAll() {
    const result = await db.query<GoogleActionTypeEntity>('SELECT * FROM google_action_types');
    return result.rows;
  }
}

export const googleActionTypesRepository = new GoogleActionTypesRepository();
