import db from "../config/db";

export interface DeviceActionType{
    id:number,
    description:string,
    google_type_id:number

}

class DeviceActionTypeRepository {
   async get(deviceId: number) {
        let result = await db.query<DeviceActionType>(
            'SELECT * FROM device_action_types WHERE id = $1', [deviceId]);

            if(result.rows.length == 0){
                throw new Error('Device action type not found');
            }
            else
                return result.rows[0];
    }

}

export const deviceActionTypeRepository = new DeviceActionTypeRepository();