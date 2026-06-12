import { createLogger } from '@lattice/logger';
import type { Prisma } from '@lattice/prisma-client';
import db from '../config/db';
import { blueprintsRepository } from '../dal/blueprints.repository';

// Prisma reads JSON as JsonValue (includes null) but writes expect InputJsonValue.
// We only copy DB→DB so the cast is always safe.
const asJson = (v: unknown): Prisma.InputJsonValue | undefined =>
  v == null ? undefined : (v as Prisma.InputJsonValue);

const log = createLogger('api:blueprint-derive');

export const blueprintDeriveService = {
  async derive(userId: number, blueprintId: number): Promise<{ userBlueprintId: number }> {
    const bp = await blueprintsRepository.findFullById(blueprintId);

    if (bp.status !== 'published') {
      throw Object.assign(new Error('Blueprint is not published'), { status: 400 });
    }

    const existing = await db.userBlueprint.findUnique({
      where: { user_id_blueprint_id: { user_id: userId, blueprint_id: blueprintId } },
    });
    if (existing) {
      throw Object.assign(new Error('Blueprint already derived for this user'), { status: 409 });
    }

    const ub = await db.$transaction(async (tx) => {
      // blueprintPipelineId → derived pipelineId (needed for rule action wiring)
      const pipelineMap = new Map<number, number>();

      // ── Step 1: Device models, action defs, devices, actions, groups ──────────
      for (const slot of bp.slots) {
        const dm = slot.device_model;

        const udm = await tx.userDeviceModel.create({
          data: {
            user_id: userId,
            source_blueprint_id: blueprintId,
            source_model_id: dm.id,
            model_key: dm.model_key,
            version: dm.version,
            display_name: dm.display_name,
          },
        });

        // Snapshot each ModelAction → UserActionDef (with traits)
        // modelActionId → userActionDefId
        const actionDefMap = new Map<number, number>();
        for (const ma of dm.actions) {
          const uad = await tx.userActionDef.create({
            data: {
              user_device_model_id: udm.id,
              source_action_id: ma.id,
              action_key: ma.action_key,
              capability: ma.capability,
              google_action_type_id: ma.google_action_type_id,
              mqtt_type: ma.mqtt_type,
              mqtt_name: ma.mqtt_name,
              params: asJson(ma.params),
              pins: asJson(ma.pins),
              telemetry_interval_ms: ma.telemetry_interval_ms,
            },
          });
          if (ma.traits.length > 0) {
            await tx.userActionDefTrait.createMany({
              data: ma.traits.map((t) => ({ user_action_def_id: uad.id, google_trait_id: t.google_trait_id })),
              skipDuplicates: true,
            });
          }
          actionDefMap.set(ma.id, uad.id);
        }

        // Create min_count placeholder UserDevices
        for (let i = 0; i < slot.min_count; i++) {
          const deviceName = slot.min_count === 1 ? slot.role : `${slot.role} #${i + 1}`;
          const ud = await tx.userDevice.create({
            data: {
              user_id: userId,
              user_device_model_id: udm.id,
              source_blueprint_id: blueprintId,
              name: deviceName,
            },
          });

          // Create UserAction for every action def on this device
          for (const ma of dm.actions) {
            const uadId = actionDefMap.get(ma.id)!;
            await tx.userAction.create({
              data: {
                user_device_id: ud.id,
                user_action_def_id: uadId,
                name: ma.action_key,
              },
            });
          }

          // Create UserActionGroup per BlueprintActionGroup per device
          for (const bpGroup of slot.action_groups) {
            await tx.userActionGroup.create({
              data: {
                user_device_id: ud.id,
                user_id: userId,
                source_blueprint_id: blueprintId,
                name: bpGroup.name,
                description: bpGroup.description ?? undefined,
                icon: bpGroup.icon ?? undefined,
                color: bpGroup.color ?? undefined,
                sort_order: bpGroup.sort_order,
              },
            });
          }
        }
      }

      // ── Step 2: Clone pipelines ───────────────────────────────────────────────
      for (const bpPipeline of bp.pipelines) {
        const pipeline = await tx.pipeline.create({
          data: {
            user_id: userId,
            source_blueprint_id: blueprintId,
            name: bpPipeline.name,
            enabled: bpPipeline.enabled,
            trigger_kind: bpPipeline.trigger_kind,
            trigger_capability: bpPipeline.trigger_capability ?? undefined,
            trigger_config: asJson(bpPipeline.trigger_config),
          },
        });
        pipelineMap.set(bpPipeline.id, pipeline.id);

        for (const stage of bpPipeline.stages) {
          await tx.pipelineStage.create({
            data: {
              pipeline_id: pipeline.id,
              position: stage.position,
              stage_kind: stage.stage_kind,
              ml_model_id: stage.ml_model_id ?? undefined,
              component_version: stage.component_version ?? undefined,
              config: asJson(stage.config),
            },
          });
        }
      }

      // ── Step 3: Clone rules (capability-scoped — no specific action IDs) ──────
      for (const bpRule of bp.rules) {
        const rule = await tx.rule.create({
          data: {
            user_id: userId,
            source_blueprint_id: blueprintId,
            name: bpRule.name,
            match: bpRule.match,
            cooldown_sec: bpRule.cooldown_sec,
            enabled: bpRule.enabled,
          },
        });

        for (const cond of bpRule.conditions) {
          await tx.ruleCondition.create({
            data: { rule_id: rule.id, kind: cond.kind, params: asJson(cond.params)! },
          });
        }

        for (const action of bpRule.actions) {
          await tx.ruleAction.create({
            data: {
              rule_id: rule.id,
              kind: action.kind,
              scope: 'capability',
              capability: action.capability ?? undefined,
              target_state: action.target_state ?? undefined,
              pipeline_id: action.blueprint_pipeline_id
                ? pipelineMap.get(action.blueprint_pipeline_id)
                : undefined,
              delay_sec: action.delay_sec,
            },
          });
        }
      }

      // ── Step 4: Clone emergency rules (capability-scoped) ────────────────────
      for (const em of bp.emergency_rules) {
        await tx.emergencyRule.create({
          data: {
            user_id: userId,
            source_blueprint_id: blueprintId,
            name: em.name,
            source_scope: 'capability',
            source_capability: em.source_capability,
            operator: em.operator,
            threshold: em.threshold,
            target_scope: 'capability',
            target_capability: em.target_capability ?? undefined,
            target_state: em.target_state ?? undefined,
            enabled: em.enabled,
          },
        });
      }

      // ── Step 5: Record derivation ─────────────────────────────────────────────
      return tx.userBlueprint.create({
        data: { user_id: userId, blueprint_id: blueprintId, version: bp.version },
      });
    });

    log.info({ userId, blueprintId, userBlueprintId: ub.id }, 'blueprint derived');
    return { userBlueprintId: ub.id };
  },
};
