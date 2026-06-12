import db from '../config/db';
import { blueprintsRepository } from '../dal/blueprints.repository';

export interface BlueprintImportPayload {
  blueprints?: any[];
}

export interface BlueprintImportResult {
  imported: number;
  blueprints: { id: number; name: string }[];
}

class BlueprintImportService {
  async importBlueprints(payload: BlueprintImportPayload, createdBy: number): Promise<BlueprintImportResult> {
    const imported: { id: number; name: string }[] = [];

    for (const bp of payload.blueprints ?? []) {
      const created = await blueprintsRepository.create({
        name: bp.name,
        description: bp.description ?? null,
        category: bp.category ?? null,
        created_by: createdBy,
      });

      await this.importSlots(created.id, bp.slots ?? []);
      await this.importActionGroups(created.id, bp.action_groups ?? []);
      await this.importPipelines(created.id, bp.pipelines ?? []);
      await this.importRules(created.id, bp.rules ?? []);
      await this.importEmergencyRules(created.id, bp.emergency_rules ?? []);

      imported.push({ id: created.id, name: created.name });
    }

    return { imported: imported.length, blueprints: imported };
  }

  private async importSlots(bpId: number, slots: any[]): Promise<void> {
    for (const slot of slots) {
      let modelId: number | undefined = slot.device_model_id;
      if (!modelId && slot.model_key) {
        const m = await db.deviceModel.findFirst({ where: { model_key: slot.model_key, version: slot.version ?? null } });
        modelId = m?.id;
      }
      if (modelId) {
        await blueprintsRepository.addSlot(bpId, {
          device_model_id: modelId,
          role: slot.role,
          min_count: slot.min_count ?? 1,
          max_count: slot.max_count ?? null,
          sort_order: slot.sort_order ?? 1,
        });
      }
    }
  }

  private async importActionGroups(bpId: number, groups: any[]): Promise<void> {
    for (const ag of groups) {
      await blueprintsRepository.addActionGroup({ ...ag, blueprint_id: bpId });
    }
  }

  private async importPipelines(bpId: number, pipelines: any[]): Promise<void> {
    for (const pipe of pipelines) {
      const newPipe = await blueprintsRepository.addPipeline(bpId, {
        name: pipe.name,
        enabled: pipe.enabled ?? true,
        trigger_kind: pipe.trigger_kind,
        trigger_capability: pipe.trigger_capability ?? null,
        trigger_config: pipe.trigger_config ?? null,
      });
      for (const stage of pipe.stages ?? []) {
        const mlModelId = await this.resolveMlModelId(stage);
        await blueprintsRepository.addPipelineStage(newPipe.id, { ...stage, ml_model_id: mlModelId });
      }
    }
  }

  private async importRules(bpId: number, rules: any[]): Promise<void> {
    for (const rule of rules) {
      const newRule = await blueprintsRepository.addRule(bpId, {
        name: rule.name,
        match: rule.match,
        cooldown_sec: rule.cooldown_sec ?? 0,
        enabled: rule.enabled ?? true,
      });
      for (const c of rule.conditions ?? []) await blueprintsRepository.addRuleCondition(newRule.id, c);
      for (const a of rule.actions ?? [])    await blueprintsRepository.addRuleAction(newRule.id, a);
    }
  }

  private async importEmergencyRules(bpId: number, rules: any[]): Promise<void> {
    for (const er of rules) {
      await blueprintsRepository.addEmergencyRule(bpId, er);
    }
  }

  private async resolveMlModelId(stage: any): Promise<number | null> {
    if (stage.ml_model_id) return stage.ml_model_id;
    if (stage.ml_model_kind && stage.ml_model_name) {
      const ml = await db.mlModel.findFirst({ where: { kind: stage.ml_model_kind, name: stage.ml_model_name } });
      return ml?.id ?? null;
    }
    return null;
  }
}

export const blueprintImportService = new BlueprintImportService();
