import db from '../config/db';

export interface DeviceActionEntity {
    id: number,
    device_id: number,
    default_name: string,
    google_type_id: number,
    type_id: number,
    mqtt_action_type: string,
    mqtt_action_name: string
}

class DeviceActionDefinitionRepository {

    async Get(deviceId: number): Promise<DeviceActionEntity[]> {
        const result = await db.query<DeviceActionEntity>(
            'SELECT * FROM device_actions WHERE device_id = $1', [deviceId]);
        return result.rows;
    }

    async GetByActionId(actionId: number): Promise<DeviceActionEntity> {
        const result = await db.query<DeviceActionEntity>(
            'SELECT * FROM device_actions WHERE device_id = $1', [actionId]);
        if (result.rows.length == 0) {
            throw new Error('Device action not found');
        }
        return result.rows[0];
    }
}
export const deviceActionDefinitionRepository = new DeviceActionDefinitionRepository();



