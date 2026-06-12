import db from '../config/db';
import { pipelinesRepository } from '../dal/pipelines.repository';
import type { TriggerKind, StageKind } from '@lattice/prisma-client';

export interface PipelineImportPayload {
  pipelines?: any[];
}

class PipelineImportService {
  async importPipelines(payload: PipelineImportPayload, userId: number): Promise<{ imported: number }> {
    const pipelines = payload.pipelines ?? [];
    let imported = 0;

    for (const p of pipelines) {
      const stages = await Promise.all(
        (p.stages ?? []).map(async (s: any) => ({
          position:          s.position,
          stage_kind:        s.stage_kind as StageKind,
          ml_model_id:       await this.resolveMlModelId(s),
          component_version: s.component_version ?? null,
          config:            s.config ?? null,
        }))
      );

      await pipelinesRepository.create({
        user_id:            userId,
        name:               p.name,
        trigger_kind:       p.trigger_kind as TriggerKind | undefined,
        trigger_capability: p.trigger_capability ?? null,
        trigger_config:     p.trigger_config ?? null,
      }, stages);

      imported++;
    }

    return { imported };
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

export const pipelineImportService = new PipelineImportService();
