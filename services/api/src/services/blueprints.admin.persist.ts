import type { BlueprintDoc } from './blueprints.admin.types';

// Doc → Prisma nested-create payload for a blueprint's children. Pure data-shaping: name
// resolution (sealed template + ml model → row id) and the version bump are decided by the caller
// (importBlueprint, which owns the transaction and the resolve-before-write ordering) and passed
// in, so this stays a deterministic mapping with no DB access of its own.

export interface PersistContext {
  /** sealed_template name → row id, pre-resolved (a missing name is a caller error). */
  templateByName: Map<string, number>;
  /** `${kind}/${name}/${version}` → ml_models.id, pre-resolved. */
  modelIds: Map<string, number>;
  /** The version this write lands as — bumped only when replacing a published definition. */
  version: number;
}

export function buildBlueprintDefinition(doc: BlueprintDoc, ctx: PersistContext) {
  const { templateByName, modelIds, version } = ctx;
  return {
    name: doc.name,
    description: doc.description ?? null,
    context_notes: doc.context_notes ?? null,
    // A re-import always lands as a draft: publishing is an explicit, validated act.
    status: 'draft',
    version,
    slots: {
      create: doc.slots.map((s, i) => ({
        key: s.key,
        label: s.label,
        required: s.required ?? true,
        min_count: s.min_count ?? 1,
        max_count: s.max_count ?? 1,
        sealed_template_id: templateByName.get(s.sealed_template)!,
        sort_order: s.sort_order ?? i,
      })),
    },
    params: {
      create: (doc.params ?? []).map((p, i) => ({
        key: p.key,
        label: p.label,
        default_value: p.default_value,
        unit: p.unit ?? null,
        user_tunable: p.user_tunable ?? true,
        sort_order: p.sort_order ?? i,
      })),
    },
    phases: {
      create: (doc.phases ?? []).map((ph) => ({
        key: ph.key,
        name: ph.name,
        ordinal: ph.ordinal,
        duration_value: ph.duration_value ?? null,
        duration_unit: ph.duration_unit ?? null,
        auto_advance: ph.auto_advance ?? false,
        context_notes: ph.context_notes ?? null,
        targets: {
          create: (ph.targets ?? []).map((t) => ({
            param_key: t.param_key,
            value: t.value,
          })),
        },
      })),
    },
    scenes: {
      create: (doc.scenes ?? []).map((sc, i) => ({
        key: sc.key,
        name: sc.name,
        sort_order: sc.sort_order ?? i,
        phase_scope: sc.phase_scope ?? [],
        members: {
          create: sc.members.map((m, j) => ({
            slot_key: m.slot_key,
            action_name: m.action_name,
            target_state: m.target_state,
            sort_order: m.sort_order ?? j,
            delay_seconds: m.delay_seconds ?? 0,
          })),
        },
      })),
    },
    rules: {
      create: (doc.rules ?? []).map((r) => ({
        key: r.key,
        name: r.name,
        is_emergency: r.is_emergency ?? false,
        condition_operator: r.condition_operator ?? 'AND',
        cooldown_seconds: r.cooldown_seconds ?? 60,
        phase_scope: r.phase_scope ?? [],
        conditions: {
          create: r.conditions.map((c) => ({
            condition_type: c.condition_type,
            slot_key: c.slot_key ?? null,
            action_name: c.action_name ?? null,
            operator: c.operator ?? null,
            threshold_value: c.threshold_value ?? null,
            status_value: c.status_value ?? null,
            schedule_time: c.schedule_time ?? null,
            schedule_days: c.schedule_days ?? [],
          })),
        },
        actions: {
          create: r.actions.map((a) => ({
            slot_key: a.slot_key,
            action_name: a.action_name,
            target_state: a.target_state,
            delay_seconds: a.delay_seconds ?? 0,
          })),
        },
      })),
    },
    pipelines: {
      create: (doc.pipelines ?? []).map((p) => ({
        key: p.key,
        name: p.name,
        enabled: p.enabled ?? true,
        phase_scope: p.phase_scope ?? [],
        sensors: {
          create: p.sensors.map((s) => ({
            group_name: s.group_name,
            description: s.description,
            slot_key: s.slot_key,
            action_name: s.action_name,
            inject_as_sensor: s.inject_as_sensor ?? true,
            inject_as_action: s.inject_as_action ?? false,
            min_value: s.min_value ?? null,
            max_value: s.max_value ?? null,
            compression: s.compression ?? 'average',
            window_minutes: s.window_minutes ?? 60,
            n: s.n ?? null,
          })),
        },
        stages: {
          create: p.stages.map((s) => ({
            ordinal: s.ordinal,
            kind: s.kind,
            ml_model_id: s.ml_model
              ? (modelIds.get(`${s.ml_model.kind}/${s.ml_model.name}/${s.ml_model.version}`) ??
                null)
              : null,
            prompt_template: s.prompt_template ?? null,
            notify: s.notify ?? null,
            execute_condition: s.execute_condition ?? null,
          })),
        },
        triggers: {
          create: p.triggers.map((t) => ({
            trigger_type: t.trigger_type,
            slot_key: t.slot_key ?? null,
            action_name: t.action_name ?? null,
            operator: t.operator ?? null,
            threshold_value: t.threshold_value ?? null,
            schedule_cron: t.schedule_cron ?? null,
            min_interval_sec: t.min_interval_sec ?? null,
          })),
        },
      })),
    },
  };
}
