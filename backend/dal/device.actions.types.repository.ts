import db from '../config/db';

export interface DeviceActionTypeEntity{
    id:number,
    description:string,
    google_type_id:number
}

class DeviceActionTypeRepository {
    async Get(deviceId: number): Promise<DeviceActionTypeEntity> {
        const result = await db.query<DeviceActionTypeEntity>(
            'SELECT * FROM device_action_types WHERE device_id = $1', [deviceId]);
       
            if(result.rows.length == 0){
                throw new Error('Device action type not found');
            }
            else
                return result.rows[0];
    }

}

export const deviceActionTypeRepository = new DeviceActionTypeRepository();