import db from '../config/db';

interface UserDeviceEntity {
  id: number;
  device_type_id: number;
  user_id: number;
  mac_id: string;
  name: string;
  online: boolean;
  last_online_date:Date;
  type: string;
  version: string;
  created_at: Date;
  updated_at: Date;
}

class UserDevicesRepository {

  async getUserDevices(userId: number) {
    const result = await db.query<UserDeviceEntity>(
      'SELECT ud.* FROM user_devices ud , devices dt WHERE ud.device_type_id = dt.id AND user_id = $1'
      , [userId]);
    return result.rows;
  }

  async getByMacId(id: string) {
    const result = await db.query<UserDeviceEntity>(
      'SELECT ud.* FROM user_devices ud , devices dt WHERE ud.device_type_id = dt.id AND  mac_id = $1', [id]);
    if (result.rows.length === 0) {
      throw new Error('Device not found');
    }
    return result.rows[0];
  }

  async getById(id: number) {
    const result = await db.query<UserDeviceEntity>(
      'SELECT ud.* FROM user_devices ud , devices dt WHERE ud.device_type_id = dt.id AND  ud.id = $1', [id]);
    if (result.rows.length === 0) {
      throw new Error('Device not found');
    }
    return result.rows[0];
  }

  async updateDeviceOnlineStatus(userId: number, id: number, deviceOnlineStatus: boolean) {
    const result = await db.query<UserDeviceEntity>(
      'UPDATE user_devices SET online = $1, last_online_date = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING *',
      [deviceOnlineStatus, id, userId],
    );
    if (result.rows.length === 0) {
      throw new Error('Device not found');
    }
    return result.rows[0];
  }


  async insertDevice(device: Partial<UserDeviceEntity>) : Promise<UserDeviceEntity> {
    const result = await db.query<UserDeviceEntity>(
      'INSERT INTO user_devices (device_type_id,user_id,mac_id,name) VALUES ($1, $2, $3,$4) RETURNING *',
      [device.device_type_id,device.user_id, device.mac_id,device.name],
    );
    return result.rows[0];
  }

  async deleteDevice(id: number, userId: number) {
    const result = await db.query(
      'DELETE FROM user_devices WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId],
    );
    if (result.rows.length === 0) {
      throw new Error('Device not found');
    }
    return result.rows[0];
  }

  async updateDevice(userId: number, id: number, updates: Partial<UserDeviceEntity>) {
    const fields = [];
    const values = [];
    let index = 3;
    values.push(id);
    values.push(userId);

    for (const key in updates) {
      fields.push(`${key} = $${index}`);
      values.push((updates as any)[key]);
      index++;
    }
    
    let query = `UPDATE user_devices SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING *`; 
    const result = await db.query<UserDeviceEntity>(
      query,
      values,
    );
    if (result.rows.length === 0) {
      throw new Error('Device not found');
    }
    return result.rows[0];
  }
}

export const userDevicesRepository = new UserDevicesRepository();
