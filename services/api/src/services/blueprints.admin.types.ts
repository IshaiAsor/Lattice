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
  fields: {
    orderBy: { sort_order: 'asc' },
    include: { options: { orderBy: { sort_order: 'asc' } } },
  },
  // Phases hang off a profile, not off the blueprint (F11): the bound devices of a profiled slot
  // each follow one, and a single-lifecycle blueprint is simply the one-profile case.
  profiles: {
    orderBy: { sort_order: 'asc' },
    include: { phases: { orderBy: { ordinal: 'asc' }, include: { targets: true } } },
  },
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

/**
 * The profile a blueprint gets when it declares none — the single-lifecycle (F10) shape, expressed
 * in the F11 model so there is one code path rather than two that must agree. The migration
 * back-filled every existing blueprint with exactly this key.
 */
export const DEFAULT_PROFILE_KEY = 'default';

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
  /**
   * Each device bound here follows its own profile and walks its own lifecycle (F11). Leave false
   * for a device the whole setup shares, which has no lifecycle of its own and follows the setup.
   */
  profiled?: boolean;
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
/**
 * How a template materialises over a multi-device slot (F11.2).
 *
 * `combined` is what every pre-F11 template does — one entity naming every bound device, so "alert
 * if any of them reports X" still works. `per_device` emits one entity per bound device of
 * `fan_out_slot_key`, each carrying that binding's id, which is the only shape that can hold a
 * `@phase.` reference once the bound devices disagree about which phase they are in.
 */
export type FanOut = 'combined' | 'per_device';
export interface FanOutDoc {
  fan_out?: FanOut;
  fan_out_slot_key?: string | null;
  /**
   * Which of the fan-out slot's devices take part, by lifecycle (F11.9). Empty/omitted = all of
   * them, so `fan_out` alone says "one each" or "one for the group" and this says "…but only for
   * these". Selection is by lifecycle rather than by device because an author writes the template
   * long before the user owns a device, and a device replanted onto another lifecycle then joins
   * and leaves the right automations on its own.
   */
  fan_out_profiles?: string[];
}

/** One question the blueprint asks the user at derive time (F11.6). */
export interface BlueprintFieldDoc {
  key: string;
  label: string;
  help_text?: string | null;
  /** text | number | select | date | boolean. */
  input_type?: string;
  /** `setup` asks once; `binding` asks once per bound device of `slot_key`. */
  scope?: 'setup' | 'binding';
  slot_key?: string | null;
  required?: boolean;
  default_value?: string | null;
  sort_order?: number;
  options?: {
    value: string;
    label: string;
    /** Choosing this option also puts the binding on this profile — one question, both facts. */
    profile_key?: string | null;
    sort_order?: number;
  }[];
}

export interface BlueprintPhaseDoc {
  key: string;
  name: string;
  ordinal: number;
  /**
   * A literal ("7") or a reference (`@param.seedling.days`) resolved per owner at evaluation time
   * (F11.13) — which is how two devices on ONE lifecycle can run a phase for different lengths.
   * A number is still accepted and stored as its text.
   */
  duration_value?: number | string | null;
  duration_unit?: string | null;
  // What ends this phase (F11.x): manual | schedule | rule | pipeline. `schedule` is the old
  // `auto_advance` and needs a duration; `rule`/`pipeline` name a template in advance_ref_key.
  // Omitted ⇒ manual. advance_to_key is the target phase in this profile (null ⇒ next by ordinal).
  advance_mode?: string;
  advance_ref_key?: string | null;
  advance_to_key?: string | null;
  /**
   * @deprecated The pre-F11.x spelling of `advance_mode: 'schedule'`. Still honoured on import so a
   * document saved before the rename keeps advancing — a silently ignored field is the worst of the
   * three options, because such a blueprint publishes clean and then never advances anything.
   * `advance_mode` wins when both are given.
   */
  auto_advance?: boolean;
  context_notes?: string | null;
  targets?: { param_key: string; value: string }[];
}
/**
 * A named lifecycle a bound device can follow (F11). A document may declare several, and a binding
 * of a profiled slot picks one.
 */
export interface BlueprintProfileDoc {
  key: string;
  label: string;
  sort_order?: number;
  phases: BlueprintPhaseDoc[];
}
export interface BlueprintSceneDoc extends FanOutDoc {
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
    /** A literal or a reference, like `duration_seconds` below (F11.14). */
    delay_seconds?: number | string | null;
    /**
     * Seconds the DEVICE holds this state before releasing it (F11.10). Null/omitted = hold
     * indefinitely. Expressing "on for a while" this way rather than as a second delayed OFF
     * action puts the timer on the device, where a service restart cannot lose it.
     *
     * A literal ("90") or a reference (`@phase.water.seconds`) since F11.14 — how long to hold is
     * usually a property of the phase, and while this was a number the only way to vary it per
     * lifecycle was to duplicate the whole template.
     */
    duration_seconds?: number | string | null;
  }[];
}
export interface BlueprintRuleDoc extends FanOutDoc {
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
    /** With `schedule_every_minutes`, turns the time into a repeating window (F11.11). */
    schedule_until?: string | null;
    schedule_every_minutes?: number | null;
    schedule_days?: number[];
  }[];
  actions: {
    slot_key: string;
    action_name: string;
    target_state: string;
    /** A literal or a reference, like `duration_seconds` below (F11.14). */
    delay_seconds?: number | string | null;
    /**
     * Seconds the DEVICE holds this state before releasing it (F11.10). Null/omitted = hold
     * indefinitely. Expressing "on for a while" this way rather than as a second delayed OFF
     * action puts the timer on the device, where a service restart cannot lose it.
     *
     * A literal ("90") or a reference (`@phase.water.seconds`) since F11.14 — "water for as long as
     * this stage says" is one rule, where three lifecycles previously needed three copies of it.
     */
    duration_seconds?: number | string | null;
  }[];
}
export interface BlueprintPipelineDoc extends FanOutDoc {
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
    /**
     * A schedule trigger, in the same shape a rule condition uses: `schedule_time` alone fires once
     * a day; add `schedule_until` + `schedule_every_minutes` for a repeating window. Replaces
     * `schedule_cron`, which nothing ever evaluated.
     */
    schedule_time?: string | null;
    schedule_until?: string | null;
    schedule_every_minutes?: number | null;
    schedule_days?: number[];
    min_interval_sec?: number | null;
  }[];
}
export interface BlueprintDoc {
  key: string;
  name: string;
  description?: string | null;
  /**
   * A **static** setup: no slot in it has phases, so nothing is scheduled anywhere (F11.8).
   * Declared, not inferred — a half-written draft also has no phases yet, and publish refuses a
   * blueprint whose flag and content disagree.
   */
  is_static?: boolean;
  context_notes?: string | null;
  slots: BlueprintSlotDoc[];
  params?: BlueprintParamDoc[];
  /** Questions the user answers when they set this up (F11.6), addressable as `@field.key`. */
  fields?: BlueprintFieldDoc[];
  /** One-profile shorthand: a document with no `profiles` puts these under the default profile. */
  phases?: BlueprintPhaseDoc[];
  /** Several lifecycles to choose between, for a blueprint whose devices run different schedules. */
  profiles?: BlueprintProfileDoc[];
  scenes?: BlueprintSceneDoc[];
  rules?: BlueprintRuleDoc[];
  pipelines?: BlueprintPipelineDoc[];
}
