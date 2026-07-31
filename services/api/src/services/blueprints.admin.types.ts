import { Prisma } from '../db';

// Shared types + Prisma include for the blueprint admin surface (authoring). Split out of
// blueprints.admin.service so the service, its validation, and its persistence layer share one
// definition of the import-document shape and the loaded-blueprint payload.

// Hoisted so the payload type can be named — an inline include leaks an unnameable
// `.prisma/client/runtime` type into the exported service (TS2742).
export const blueprintInclude = {
  slots: {
    include: {
      sealed_template: {
        select: {
          id: true,
          name: true,
          status: true,
          entries: { select: { mqtt_action_name: true } },
        },
      },
    },
  },
  params: true,
  phases: { include: { targets: true } },
  scenes: { include: { members: true } },
  rules: { include: { conditions: true, actions: true } },
  pipelines: {
    include: {
      sensors: true,
      // The model is included as (kind, name, version), not just its row id: that is the portable
      // form the import document uses, so the builder can round-trip a saved blueprint without
      // silently dropping the model off every infer stage.
      stages: { include: { ml_model: { select: { kind: true, name: true, version: true } } } },
      triggers: true,
    },
  },
} satisfies Prisma.BlueprintInclude;

export type FullBlueprint = Prisma.BlueprintGetPayload<{ include: typeof blueprintInclude }>;
export type BlueprintRow = Prisma.BlueprintGetPayload<object>;

export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
export function notFound(message = 'Blueprint not found'): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}
export function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// ─── Import document shape ──────────────────────────────────────────────────────────────────
//
// Until the builder UI existed this was the only authoring surface; it stays the wire shape the
// builder round-trips (import/export) and a whole vertical can be defined as JSON and re-imported
// idempotently by `key`. Sealed templates and ML models are referenced by NAME, not row id, so a
// document survives being imported into another database.

export interface BlueprintSlotDoc {
  key: string;
  label: string;
  required?: boolean;
  min_count?: number;
  max_count?: number;
  // Referenced by name, not id: a JSON document must survive being imported into another
  // database where the row ids differ.
  sealed_template: string;
  sort_order?: number;
}
export interface BlueprintParamDoc {
  key: string;
  label: string;
  default_value: string;
  unit?: string | null;
  user_tunable?: boolean;
  sort_order?: number;
}
export interface BlueprintPhaseDoc {
  key: string;
  name: string;
  ordinal: number;
  duration_value?: number | null;
  duration_unit?: string | null;
  auto_advance?: boolean;
  context_notes?: string | null;
  targets?: { param_key: string; value: string }[];
}
export interface BlueprintSceneDoc {
  key: string;
  name: string;
  sort_order?: number;
  // Phase keys this scene is offered in (F10). Empty/omitted = every phase.
  phase_scope?: string[];
  members: {
    slot_key: string;
    action_name: string;
    target_state: string;
    sort_order?: number;
    delay_seconds?: number;
  }[];
}
export interface BlueprintRuleDoc {
  key: string;
  name: string;
  is_emergency?: boolean;
  condition_operator?: string;
  cooldown_seconds?: number;
  // Phase keys this rule is active in (F10). Empty/omitted = every phase.
  phase_scope?: string[];
  conditions: {
    condition_type: string;
    slot_key?: string | null;
    action_name?: string | null;
    operator?: string | null;
    threshold_value?: string | null;
    status_value?: string | null;
    schedule_time?: string | null;
    schedule_days?: number[];
  }[];
  actions: {
    slot_key: string;
    action_name: string;
    target_state: string;
    delay_seconds?: number;
  }[];
}
export interface BlueprintPipelineDoc {
  key: string;
  name: string;
  enabled?: boolean;
  // Phase keys this pipeline's triggers are live in (F10). Empty/omitted = every phase.
  phase_scope?: string[];
  sensors: {
    group_name: string;
    description: string;
    slot_key: string;
    action_name: string;
    inject_as_sensor?: boolean;
    inject_as_action?: boolean;
    min_value?: string | null;
    max_value?: string | null;
    compression?: string;
    window_minutes?: number;
    n?: number | null;
  }[];
  stages: {
    ordinal: number;
    kind: string;
    // Resolved to ml_models.id via the (kind, name, version) unique key — same portability
    // reason as sealed_template above.
    ml_model?: { kind: string; name: string; version: string } | null;
    prompt_template?: string | null;
    notify?: string | null;
    execute_condition?: string | null;
  }[];
  triggers: {
    trigger_type: string;
    slot_key?: string | null;
    action_name?: string | null;
    operator?: string | null;
    threshold_value?: string | null;
    schedule_cron?: string | null;
    min_interval_sec?: number | null;
  }[];
}
export interface BlueprintDoc {
  key: string;
  name: string;
  description?: string | null;
  context_notes?: string | null;
  slots: BlueprintSlotDoc[];
  params?: BlueprintParamDoc[];
  phases?: BlueprintPhaseDoc[];
  scenes?: BlueprintSceneDoc[];
  rules?: BlueprintRuleDoc[];
  pipelines?: BlueprintPipelineDoc[];
}
