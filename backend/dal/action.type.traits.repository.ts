import db from "../config/db";

export interface ActionTypeTraitEntity {
    id: number,
    device_action_type_id: number,
    google_trait_id: number
}

class ActionTypeTraitRepository {

    async GetByActionId(actionId: number): Promise<ActionTypeTraitEntity[]> {
        const result = await db.query<ActionTypeTraitEntity>(
            'SELECT * FROM action_type_traits WHERE device_action_type_id = $1', [actionId]);
        return result.rows;
    }
}
export const actionTypeTraitRepository = new ActionTypeTraitRepository();