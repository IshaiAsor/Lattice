import db from '../config/db';
import type { Prisma } from '@lattice/prisma-client';

export type FullBlueprint = Awaited<ReturnType<typeof blueprintsRepository.findFullById>>;

class BlueprintsRepository {
  // ─── Admin ──────────────────────────────────────────────────────────────────

  async listAll() {
    return db.blueprint.findMany({ orderBy: { created_at: 'desc' } });
  }

  async findFullById(id: number) {
    return db.blueprint.findUniqueOrThrow({
      where: { id },
      include: {
        slots: {
          include: {
            device_model: { include: { actions: { include: { traits: true } } } },
            action_groups: { orderBy: { sort_order: 'asc' } },
          },
          orderBy: { sort_order: 'asc' },
        },
        pipelines: {
          include: { stages: { orderBy: { position: 'asc' } } },
        },
        rules: {
          include: { conditions: true, actions: true },
        },
        emergency_rules: true,
      },
    });
  }

  async create(data: { name: string; description?: string; category?: string; created_by: number }) {
    return db.blueprint.create({ data });
  }

  async update(id: number, data: { name?: string; description?: string; category?: string }) {
    return db.blueprint.update({ where: { id }, data: { ...data, updated_at: new Date() } });
  }

  async publish(id: number) {
    return db.blueprint.update({
      where: { id },
      data: { status: 'published', version: { increment: 1 }, updated_at: new Date() },
    });
  }

  async delete(id: number) {
    await db.blueprint.delete({ where: { id } });
  }

  // ─── User-facing ────────────────────────────────────────────────────────────

  async listPublished() {
    return db.blueprint.findMany({ where: { status: 'published' }, orderBy: { name: 'asc' } });
  }

  // ─── Slots ──────────────────────────────────────────────────────────────────

  async addSlot(blueprintId: number, data: {
    device_model_id: number;
    role: string;
    min_count?: number;
    max_count?: number;
    sort_order?: number;
  }) {
    return db.blueprintDeviceSlot.create({ data: { blueprint_id: blueprintId, min_count: 1, ...data } });
  }

  async deleteSlot(slotId: number) {
    await db.blueprintDeviceSlot.delete({ where: { id: slotId } });
  }

  // ─── Action groups ───────────────────────────────────────────────────────────

  async addActionGroup(data: {
    blueprint_id: number;
    blueprint_device_slot_id: number;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    sort_order?: number;
  }) {
    return db.blueprintActionGroup.create({ data });
  }

  async deleteActionGroup(id: number) {
    await db.blueprintActionGroup.delete({ where: { id } });
  }

  // ─── Pipelines ──────────────────────────────────────────────────────────────

  async addPipeline(blueprintId: number, data: {
    name: string;
    enabled?: boolean;
    trigger_kind?: string;
    trigger_capability?: string;
    trigger_config?: Prisma.InputJsonValue;
  }) {
    return db.blueprintPipeline.create({ data: { blueprint_id: blueprintId, ...data } as any });
  }

  async deletePipeline(id: number) {
    await db.blueprintPipeline.delete({ where: { id } });
  }

  async addPipelineStage(pipelineId: number, data: {
    position: number;
    stage_kind: string;
    ml_model_id?: number;
    component_version?: string;
    config?: Prisma.InputJsonValue;
  }) {
    return db.blueprintPipelineStage.create({ data: { blueprint_pipeline_id: pipelineId, ...data } as any });
  }

  async deletePipelineStage(id: number) {
    await db.blueprintPipelineStage.delete({ where: { id } });
  }

  // ─── Rules ──────────────────────────────────────────────────────────────────

  async addRule(blueprintId: number, data: {
    name: string;
    match?: string;
    cooldown_sec?: number;
    enabled?: boolean;
  }) {
    return db.blueprintRule.create({ data: { blueprint_id: blueprintId, ...data } });
  }

  async deleteRule(id: number) {
    await db.blueprintRule.delete({ where: { id } });
  }

  async addRuleCondition(ruleId: number, data: { kind: string; params: Prisma.InputJsonValue }) {
    return db.blueprintRuleCondition.create({ data: { blueprint_rule_id: ruleId, ...data } });
  }

  async deleteRuleCondition(id: number) {
    await db.blueprintRuleCondition.delete({ where: { id } });
  }

  async addRuleAction(ruleId: number, data: {
    kind?: string;
    capability?: string;
    target_state?: string;
    blueprint_pipeline_id?: number;
    delay_sec?: number;
  }) {
    return db.blueprintRuleAction.create({ data: { blueprint_rule_id: ruleId, ...data } as any });
  }

  async deleteRuleAction(id: number) {
    await db.blueprintRuleAction.delete({ where: { id } });
  }

  // ─── Emergency rules ─────────────────────────────────────────────────────────

  async addEmergencyRule(blueprintId: number, data: {
    name: string;
    source_capability: string;
    operator: string;
    threshold: string;
    target_capability?: string;
    target_state?: string;
    enabled?: boolean;
  }) {
    return db.blueprintEmergencyRule.create({ data: { blueprint_id: blueprintId, ...data } });
  }

  async updateEmergencyRule(id: number, data: Partial<{
    name: string;
    source_capability: string;
    operator: string;
    threshold: string;
    target_capability: string;
    target_state: string;
    enabled: boolean;
  }>) {
    return db.blueprintEmergencyRule.update({ where: { id }, data });
  }

  async deleteEmergencyRule(id: number) {
    await db.blueprintEmergencyRule.delete({ where: { id } });
  }
}

export const blueprintsRepository = new BlueprintsRepository();
