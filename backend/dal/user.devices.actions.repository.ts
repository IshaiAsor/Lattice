import db from '../config/db';

interface UserDevicesActionEntity {
  id: number;
  user_device_id: number;
  action_id: number;
  action_name: string;
  current_state: any;
  created_at: Date;
  updated_at: Date;
  google_type_id: number;
  mqtt_action_type: string;
  mqtt_action_name: string;
}

class UserDevicesActionsRepository {

  constructor() { }

  async updateState(id: number, state: any) {
    const result = await db.query(
      'UPDATE user_device_actions SET current_state = $1, updated_at = CURRENT_TIMESTAMP WHERE action_id = $2 RETURNING *',
      [state, id],
    );
    if (result.rows.length === 0) {
      throw new Error('Device action not found');
    }
    return result.rows[0];
  }

  async getByDeviceId(deviceId: number) {
    const result = await db.query<UserDevicesActionEntity>(
      'SELECT * FROM user_device_actions uda , device_actions da WHERE uda.action_id = da.id  AND uda.user_device_id = $1',
      [deviceId],
    );
    return result.rows;
  }


  async insertAction(action: Partial<UserDevicesActionEntity>) {
    const result = await db.query<UserDevicesActionEntity>(
      'INSERT INTO user_device_actions ( user_device_id, action_id, action_name,current_state) VALUES ($1, $2, $3, $4) RETURNING *',
      [action.user_device_id, action.action_id,action.action_name, action.current_state],
    );
    return result.rows[0];
  }

  async deleteAction(actionId: number) {
    const result = await db.query('DELETE FROM user_device_actions WHERE id = $1 RETURNING *', [
      actionId
    ]);
    if (result.rows.length === 0) {
      throw new Error('Device action not found');
    }
    return result.rows[0];
  }

  async getById(actionId: number) {
    const result = await db.query<UserDevicesActionEntity>(
      'SELECT * FROM user_device_actions  uda , device_actions da WHERE uda.action_id = da.id AND uda.action_id = $1',
      [actionId],
    );
    if (result.rows.length === 0) {
      throw new Error('Device action not found');
    }
    return result.rows[0];
  }

  async updateAction(id: number, updates: Partial<UserDevicesActionEntity>) {

    const fields = [];
    const values = [];
    let index = 1;
    for (const key in updates) {
      fields.push(`${key} = $${index}`);
      values.push((updates as any)[key]);
      index++;
    }
    values.push(id);

    const result = await db.query<UserDevicesActionEntity>(
      `UPDATE user_device_actions SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $${index} RETURNING *`,
      values,
    );

    if (result.rows.length === 0) {
      throw new Error('Device action not found');
    }
    else {
      return result.rows[0];
    }

  }
}

export const userDevicesActionsRepository = new UserDevicesActionsRepository();
