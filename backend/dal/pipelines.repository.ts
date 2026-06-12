import db from '../config/db';
import { Pipeline, PipelineStage, PipelineRun, TriggerKind, StageKind, Prisma } from '@lattice/prisma-client';

export type PipelineWithStages = Pipeline & { stages: PipelineStage[] };

export type CreatePipelineInput = {
  user_id: number;
  name: string;
  trigger_kind?: TriggerKind;
  trigger_capability?: string | null;
  trigger_config?: Prisma.InputJsonValue | null;
  source_blueprint_id?: number | null;
};

export type CreateStageInput = {
  position: number;
  stage_kind: StageKind;
  ml_model_id?: number | null;
  component_version?: string | null;
  config?: Prisma.InputJsonValue | null;
};

// Prisma Json? fields don't accept raw `null` — map it to DbNull (SQL NULL).
const dbNullJson = (v: Prisma.InputJsonValue | null | undefined) =>
  v === null ? Prisma.DbNull : v;

const stageData = (s: CreateStageInput) => ({
  position: s.position,
  stage_kind: s.stage_kind,
  ml_model_id: s.ml_model_id ?? null,
  component_version: s.component_version ?? null,
  config: dbNullJson(s.config),
});

class PipelinesRepository {
  async getByUserId(userId: number): Promise<PipelineWithStages[]> {
    return db.pipeline.findMany({
      where: { user_id: userId },
      include: { stages: { orderBy: { position: 'asc' } } },
      orderBy: { created_at: 'asc' },
    });
  }

  async getById(id: number, userId: number): Promise<PipelineWithStages> {
    return db.pipeline.findFirstOrThrow({
      where: { id, user_id: userId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  }

  async create(data: CreatePipelineInput, stages: CreateStageInput[] = []): Promise<PipelineWithStages> {
    return db.pipeline.create({
      data: {
        user_id: data.user_id,
        name: data.name,
        trigger_kind: data.trigger_kind,
        trigger_capability: data.trigger_capability ?? null,
        trigger_config: dbNullJson(data.trigger_config),
        source_blueprint_id: data.source_blueprint_id ?? null,
        ...(stages.length ? { stages: { create: stages.map(stageData) } } : {}),
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    }) as unknown as PipelineWithStages;
  }

  async update(id: number, userId: number, data: Partial<Omit<CreatePipelineInput, 'user_id'>>): Promise<Pipeline> {
    return db.pipeline.update({
      where: { id, user_id: userId },
      data: {
        ...data,
        trigger_config: 'trigger_config' in data ? dbNullJson(data.trigger_config) : undefined,
      } as any,
    });
  }

  async toggle(id: number, userId: number, enabled: boolean): Promise<void> {
    await db.pipeline.updateMany({ where: { id, user_id: userId }, data: { enabled } });
  }

  async delete(id: number, userId: number): Promise<void> {
    await db.pipeline.deleteMany({ where: { id, user_id: userId } });
  }

  // ─── Stage management ─────────────────────────────────────────────────────

  async replaceStages(pipelineId: number, userId: number, stages: CreateStageInput[]): Promise<PipelineWithStages> {
    return db.$transaction(async (tx) => {
      await tx.pipeline.findFirstOrThrow({ where: { id: pipelineId, user_id: userId } });
      await tx.pipelineStage.deleteMany({ where: { pipeline_id: pipelineId } });
      return tx.pipeline.update({
        where: { id: pipelineId },
        data: { stages: { create: stages.map(stageData) } },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
    }) as unknown as PipelineWithStages;
  }

  async addStage(pipelineId: number, userId: number, stage: CreateStageInput): Promise<PipelineStage> {
    await db.pipeline.findFirstOrThrow({ where: { id: pipelineId, user_id: userId } });
    return db.pipelineStage.create({ data: { ...stageData(stage), pipeline_id: pipelineId } }) as unknown as PipelineStage;
  }

  async updateStage(stageId: number, pipelineId: number, userId: number, data: Partial<CreateStageInput>): Promise<PipelineStage> {
    await db.pipeline.findFirstOrThrow({ where: { id: pipelineId, user_id: userId } });
    return db.pipelineStage.update({
      where: { id: stageId, pipeline_id: pipelineId },
      data: {
        ...data,
        config: 'config' in data ? dbNullJson(data.config) : undefined,
        ml_model_id: 'ml_model_id' in data ? (data.ml_model_id ?? null) : undefined,
      } as any,
    });
  }

  async deleteStage(stageId: number, pipelineId: number, userId: number): Promise<void> {
    await db.pipeline.findFirstOrThrow({ where: { id: pipelineId, user_id: userId } });
    await db.pipelineStage.delete({ where: { id: stageId, pipeline_id: pipelineId } });
  }

  // ─── Bulk import ─────────────────────────────────────────────────────────

  async bulkImportForUser(userId: number, pipelines: Array<{
    name: string;
    trigger_kind?: TriggerKind;
    trigger_capability?: string | null;
    trigger_config?: Prisma.InputJsonValue | null;
    stages: Array<CreateStageInput & { ml_model_id?: number | null }>;
  }>): Promise<number> {
    let count = 0;
    for (const p of pipelines) {
      await this.create({
        user_id: userId,
        name: p.name,
        trigger_kind: p.trigger_kind,
        trigger_capability: p.trigger_capability ?? null,
        trigger_config: p.trigger_config ?? null,
      }, p.stages);
      count++;
    }
    return count;
  }

  // ─── Run history ──────────────────────────────────────────────────────────

  async getRecentRuns(pipelineId: number, userId: number, limit = 20): Promise<PipelineRun[]> {
    await db.pipeline.findFirstOrThrow({ where: { id: pipelineId, user_id: userId } });
    return db.pipelineRun.findMany({
      where: { pipeline_id: pipelineId },
      include: { stage_runs: { orderBy: { position: 'asc' } } },
      orderBy: { started_at: 'desc' },
      take: limit,
    }) as unknown as PipelineRun[];
  }
}

export const pipelinesRepository = new PipelinesRepository();
