import { actionTypeTraitRepository } from "../dal/action.type.traits.repository";
import { googleTraitsRepository } from "../dal/google.action.traits.repository";

export interface GoogleActionTraitView {
    id: number;
    name: string;
    value: string;
}


class GoogleActionsTraitsService {
    async getGoogleActionTraits(): Promise<GoogleActionTraitView[] | null | undefined> {
        const traits = await googleTraitsRepository.getAll();
        return traits?.map((trait) => {
            return {
                id: trait.id,
                name: trait.name,
                value: trait.value
            };
        });
    }

    async GetActionDefinitionTraits(actionId: number): Promise<GoogleActionTraitView[]> {
        let traits = await googleTraitsRepository.getAll();
        let actionTraits = await actionTypeTraitRepository.GetByActionId(actionId);

        return actionTraits?.map((actionTrait) => {
            let traitDef = traits?.find((t) => t.id === actionTrait.google_trait_id);
            return {
                id: actionTrait.id,
                name: traitDef?.name || '',
                value: traitDef?.value || ''
            }
        });
    }
}

export const googleActionsTraitsService = new GoogleActionsTraitsService();