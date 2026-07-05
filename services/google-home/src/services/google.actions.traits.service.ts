import { db } from '@lattice/prisma-client';

export interface GoogleActionTraitView {
  id: number;
  name: string;
  value: string;
  validParameters: unknown;
}

class GoogleActionsTraitsService {
  async GetActionDefinitionTraits(capabilityId: number): Promise<GoogleActionTraitView[]> {
    const [traits, capabilityTraits] = await Promise.all([
      db.googleDeviceTrait.findMany(),
      db.deviceCapabilityTrait.findMany({ where: { capability_id: capabilityId } }),
    ]);
    return capabilityTraits.map((capabilityTrait) => {
      const traitDef = traits.find((t) => t.id === capabilityTrait.google_trait_id);
      return {
        id: capabilityTrait.id,
        name: traitDef?.name ?? '',
        value: traitDef?.value ?? '',
        validParameters: traitDef?.valid_parameters,
      };
    });
  }
}

export const googleActionsTraitsService = new GoogleActionsTraitsService();
