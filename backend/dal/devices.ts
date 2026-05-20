import db from '../config/db';

export interface Device {
    id: number,
    type: string,
    version: string,
    default_name: string,
    created_at: Date,
    updated_at: Date
};

class DevicesRepository {

    async GetAll(): Promise<Device[]> {
        const result = await db.query<Device>('SELECT * FROM devices');
        return result.rows;
    }

    async GetByType(type: string, version: string): Promise<Device> {
        const result = await db.query<Device>(
            'SELECT * FROM devices WHERE type = $1 AND version = $2', [type, version]);
        if (result.rows.length == 0) {
            throw new Error('Device not found');
        }
        return result.rows[0];
    }
}
export const devicesRepository = new DevicesRepository();


