// The editor's working model for a blueprint (F10.9).
//
// Deliberately the *same shape* the import endpoint accepts, so the builder never needs a
// translation layer that could drift from the API: slots reference a sealed template by name, ML
// models by (kind, name, version), and actions by (slot_key, action_name). Optional fields are
// non-optional here with sane empties, because a form always has a value — `toDocument()` strips
// the empties back out on save.

export interface SlotDraft {
  key: string;
  label: string;
  required: boolean;
  // How many devices fill this slot. 1..1 is a single device; a larger max makes it a
  // multi-device slot (e.g. many pots) whose template references fan out to every bound device.
  min_count: number;
  max_count: number;
  sealed_template: string;
}

export interface ParamDraft {
  key: string;
  label: string;
  default_value: string;
  unit: string;
  user_tunable: boolean;
}

export interface PhaseTargetDraft {
  param_key: string;
  value: string;
}

export interface PhaseDraft {
  key: string;
  name: string;
  ordinal: number;
  duration_value: number | null;
  duration_unit: string;
  auto_advance: boolean;
  context_notes: string;
  targets: PhaseTargetDraft[];
}

export interface SceneMemberDraft {
  slot_key: string;
  action_name: string;
  target_state: string;
  delay_seconds: number;
}

export interface SceneDraft {
  key: string;
  name: string;
  // Phases this scene is offered in (F10). Empty = every phase.
  phase_scope: string[];
  members: SceneMemberDraft[];
}

export interface RuleConditionDraft {
  condition_type: string;
  slot_key: string;
  action_name: string;
  operator: string;
  threshold_value: string;
  status_value: string;
  schedule_time: string;
  /** Weekday numbers (0 = Sunday). Empty means every day. */
  schedule_days: number[];
}

export interface RuleActionDraft {
  slot_key: string;
  action_name: string;
  target_state: string;
  delay_seconds: number;
}

export interface RuleDraft {
  key: string;
  name: string;
  is_emergency: boolean;
  // Phases this rule is active in (F10). Empty = every phase.
  phase_scope: string[];
  condition_operator: string;
  // The rule stores cooldown_seconds (an Int the engine reads directly), but the form edits a
  // value + unit so a 5-minute cooldown isn't typed as 300. Converted on the document boundary.
  cooldown_value: number;
  cooldown_unit: string;
  conditions: RuleConditionDraft[];
  actions: RuleActionDraft[];
}

export interface PipelineSensorDraft {
  group_name: string;
  description: string;
  slot_key: string;
  action_name: string;
  inject_as_sensor: boolean;
  inject_as_action: boolean;
  min_value: string;
  max_value: string;
  compression: string;
  window_minutes: number;
  /** Sample count for the `last_n` compression; ignored by the others. */
  n: number | null;
}

export interface PipelineStageDraft {
  ordinal: number;
  kind: string;
  ml_model: { kind: string; name: string; version: string } | null;
  // Typed stage fields, matching the columns. `prompt_template` is the infer stage's; `notify`
  // and `execute_condition` belong to command_exec.
  prompt_template: string;
  notify: string;
  execute_condition: string;
}

export interface PipelineTriggerDraft {
  trigger_type: string;
  slot_key: string;
  action_name: string;
  operator: string;
  threshold_value: string;
  schedule_cron: string;
  min_interval_sec: number | null;
}

export interface PipelineDraft {
  key: string;
  name: string;
  enabled: boolean;
  // Phases this pipeline's triggers are live in (F10). Empty = every phase.
  phase_scope: string[];
  sensors: PipelineSensorDraft[];
  stages: PipelineStageDraft[];
  triggers: PipelineTriggerDraft[];
}

export interface BlueprintDraft {
  key: string;
  name: string;
  description: string;
  context_notes: string;
  slots: SlotDraft[];
  params: ParamDraft[];
  phases: PhaseDraft[];
  scenes: SceneDraft[];
  rules: RuleDraft[];
  pipelines: PipelineDraft[];
}

/**
 * Machine identity from human text. Keys are never typed by an author: a blueprint's `key` is only
 * an idempotency handle for import, and a slot's `key` is only how templates and bindings refer to
 * it. Asking someone to invent both a name and an id for the same thing is asking them to keep two
 * things in step for no benefit.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Slug `text`, suffixed if it collides with one already in use. */
export function uniqueSlug(text: string, taken: Iterable<string>): string {
  const base = slugify(text);
  if (!base) return '';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// Kept in step with UNIT_MS in automation-worker/phases-logic.ts — a unit the worker can't convert
// resolves to null and the phase silently never advances.
export const DURATION_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months'];
// Cooldown is stored as seconds; these are the units the builder offers, with their factor to
// seconds. Shorter set than phase durations — a rule cooldown in weeks or months isn't a thing.
export const COOLDOWN_UNITS = ['seconds', 'minutes', 'hours', 'days'];
const COOLDOWN_UNIT_SECONDS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

export function cooldownToSeconds(value: number, unit: string): number {
  const factor = COOLDOWN_UNIT_SECONDS[unit] ?? 1;
  return Math.max(0, Math.round((value || 0) * factor));
}

/** Seconds → the largest unit that divides evenly, so 300 shows as 5 minutes and 90 stays 90 s. */
export function secondsToCooldown(seconds: number): { value: number; unit: string } {
  for (const unit of ['days', 'hours', 'minutes']) {
    const factor = COOLDOWN_UNIT_SECONDS[unit];
    if (seconds >= factor && seconds % factor === 0) return { value: seconds / factor, unit };
  }
  return { value: seconds, unit: 'seconds' };
}

export const CONDITION_TYPES = ['threshold', 'device_status', 'schedule'];
export const OPERATORS = ['<', '<=', '>', '>=', '=', '!='];
export const STAGE_KINDS = ['enrich', 'infer', 'command_exec'];
export const TRIGGER_TYPES = ['schedule', 'sensor_threshold', 'manual'];
export const COMPRESSIONS = ['average', 'last_n', 'min_max', 'min_max_avg', 'time_series'];

export function emptyDraft(): BlueprintDraft {
  return {
    key: '',
    name: '',
    description: '',
    context_notes: '',
    slots: [],
    params: [],
    phases: [],
    scenes: [],
    rules: [],
    pipelines: [],
  };
}

export function newSlot(): SlotDraft {
  return { key: '', label: '', required: true, min_count: 1, max_count: 1, sealed_template: '' };
}
export function newParam(): ParamDraft {
  return { key: '', label: '', default_value: '', unit: '', user_tunable: true };
}
export function newPhase(ordinal: number): PhaseDraft {
  return {
    key: '',
    name: '',
    ordinal,
    duration_value: null,
    duration_unit: 'days',
    auto_advance: false,
    context_notes: '',
    targets: [],
  };
}
export function newScene(): SceneDraft {
  return { key: '', name: '', phase_scope: [], members: [] };
}
export function newSceneMember(): SceneMemberDraft {
  return { slot_key: '', action_name: '', target_state: '', delay_seconds: 0 };
}
export function newRule(): RuleDraft {
  return {
    key: '',
    name: '',
    is_emergency: false,
    phase_scope: [],
    condition_operator: 'AND',
    cooldown_value: 1,
    cooldown_unit: 'minutes',
    conditions: [],
    actions: [],
  };
}
export function newCondition(): RuleConditionDraft {
  return {
    condition_type: 'threshold',
    slot_key: '',
    action_name: '',
    operator: '<',
    threshold_value: '',
    status_value: '',
    schedule_time: '',
    schedule_days: [],
  };
}
export function newRuleAction(): RuleActionDraft {
  return { slot_key: '', action_name: '', target_state: '', delay_seconds: 0 };
}
export function newPipeline(): PipelineDraft {
  return { key: '', name: '', enabled: true, phase_scope: [], sensors: [], stages: [], triggers: [] };
}
export function newSensor(): PipelineSensorDraft {
  return {
    group_name: '',
    description: '',
    slot_key: '',
    action_name: '',
    inject_as_sensor: true,
    inject_as_action: false,
    min_value: '',
    max_value: '',
    compression: 'average',
    window_minutes: 60,
    n: null,
  };
}
export function newStage(ordinal: number): PipelineStageDraft {
  return {
    ordinal,
    kind: 'enrich',
    ml_model: null,
    prompt_template: '',
    notify: '',
    execute_condition: '',
  };
}
export function newTrigger(): PipelineTriggerDraft {
  return {
    trigger_type: 'schedule',
    slot_key: '',
    action_name: '',
    operator: '<',
    threshold_value: '',
    schedule_cron: '0 */6 * * *',
    min_interval_sec: null,
  };
}

// ─── Draft ⇄ import document ─────────────────────────────────────────────────────────────────

const blank = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

/** Strip the form's empty strings back to absent fields so the saved document stays minimal. */
export function toDocument(d: BlueprintDraft): unknown {
  return {
    key: d.key.trim(),
    name: d.name.trim(),
    description: blank(d.description),
    context_notes: blank(d.context_notes),
    slots: d.slots.map((s, i) => ({
      key: s.key.trim(),
      label: s.label.trim(),
      required: s.required,
      min_count: s.min_count,
      max_count: s.max_count,
      sealed_template: s.sealed_template,
      sort_order: i,
    })),
    params: d.params.map((p, i) => ({
      key: p.key.trim(),
      label: p.label.trim(),
      default_value: p.default_value,
      unit: blank(p.unit),
      user_tunable: p.user_tunable,
      sort_order: i,
    })),
    phases: d.phases.map((p) => ({
      key: p.key.trim(),
      name: p.name.trim(),
      ordinal: p.ordinal,
      duration_value: p.duration_value ?? undefined,
      duration_unit: p.duration_value ? p.duration_unit : undefined,
      auto_advance: p.auto_advance,
      context_notes: blank(p.context_notes),
      targets: p.targets
        .filter((t) => t.param_key)
        .map((t) => ({ param_key: t.param_key, value: t.value })),
    })),
    scenes: d.scenes.map((s, i) => ({
      key: s.key.trim(),
      name: s.name.trim(),
      sort_order: i,
      phase_scope: [...s.phase_scope],
      members: s.members.map((m, j) => ({
        slot_key: m.slot_key,
        action_name: m.action_name,
        target_state: m.target_state,
        sort_order: j,
        delay_seconds: m.delay_seconds,
      })),
    })),
    rules: d.rules.map((r) => ({
      key: r.key.trim(),
      name: r.name.trim(),
      is_emergency: r.is_emergency,
      phase_scope: [...r.phase_scope],
      condition_operator: r.condition_operator,
      cooldown_seconds: cooldownToSeconds(r.cooldown_value, r.cooldown_unit),
      conditions: r.conditions.map((c) => ({
        condition_type: c.condition_type,
        slot_key: blank(c.slot_key),
        action_name: blank(c.action_name),
        operator: c.condition_type === 'threshold' ? c.operator : undefined,
        threshold_value: c.condition_type === 'threshold' ? blank(c.threshold_value) : undefined,
        status_value: c.condition_type === 'device_status' ? blank(c.status_value) : undefined,
        schedule_time: c.condition_type === 'schedule' ? blank(c.schedule_time) : undefined,
        // Empty means "every day", which is also the column default — send it only when set.
        schedule_days:
          c.condition_type === 'schedule' && c.schedule_days.length > 0
            ? [...c.schedule_days].sort((a, b) => a - b)
            : undefined,
      })),
      actions: r.actions.map((a) => ({
        slot_key: a.slot_key,
        action_name: a.action_name,
        target_state: a.target_state,
        delay_seconds: a.delay_seconds,
      })),
    })),
    pipelines: d.pipelines.map((p) => ({
      key: p.key.trim(),
      name: p.name.trim(),
      enabled: p.enabled,
      phase_scope: [...p.phase_scope],
      sensors: p.sensors.map((s) => ({
        group_name: s.group_name.trim(),
        description: s.description.trim(),
        slot_key: s.slot_key,
        action_name: s.action_name,
        inject_as_sensor: s.inject_as_sensor,
        inject_as_action: s.inject_as_action,
        min_value: blank(s.min_value),
        max_value: blank(s.max_value),
        compression: s.compression,
        window_minutes: s.window_minutes,
        // Only last_n consumes a sample count; sending it for the others is noise.
        n: s.compression === 'last_n' ? (s.n ?? null) : null,
      })),
      stages: p.stages.map((s) => ({
        ordinal: s.ordinal,
        kind: s.kind,
        ml_model: s.kind === 'infer' ? s.ml_model : undefined,
        prompt_template: s.kind === 'infer' ? blank(s.prompt_template) : undefined,
        notify: s.kind === 'command_exec' ? blank(s.notify) : undefined,
        execute_condition: s.kind === 'command_exec' ? blank(s.execute_condition) : undefined,
      })),
      triggers: p.triggers.map((t) => ({
        trigger_type: t.trigger_type,
        slot_key: t.trigger_type === 'sensor_threshold' ? blank(t.slot_key) : undefined,
        action_name: t.trigger_type === 'sensor_threshold' ? blank(t.action_name) : undefined,
        operator: t.trigger_type === 'sensor_threshold' ? t.operator : undefined,
        threshold_value:
          t.trigger_type === 'sensor_threshold' ? blank(t.threshold_value) : undefined,
        schedule_cron: t.trigger_type === 'schedule' ? blank(t.schedule_cron) : undefined,
        min_interval_sec: t.min_interval_sec ?? undefined,
      })),
    })),
  };
}

/** The server's row shape, read back into the form. Only the fields the editor owns. */
export interface RawBlueprint {
  key: string;
  name: string;
  description: string | null;
  context_notes: string | null;
  slots?: {
    key: string;
    label: string;
    required: boolean;
    min_count?: number;
    max_count?: number;
    // Two shapes reach here: the API's getBlueprint returns the relation as an object, while a
    // pasted/seed *document* names it as a plain string. toDraft accepts both.
    sealed_template?: string | { name: string };
  }[];
  params?: {
    key: string;
    label: string;
    default_value: string;
    unit: string | null;
    user_tunable: boolean;
  }[];
  phases?: {
    key: string;
    name: string;
    ordinal: number;
    duration_value: number | null;
    duration_unit: string | null;
    auto_advance: boolean;
    context_notes: string | null;
    targets?: { param_key: string; value: string }[];
  }[];
  scenes?: {
    key: string;
    name: string;
    phase_scope?: string[];
    members?: {
      slot_key: string;
      action_name: string;
      target_state: string;
      delay_seconds: number;
    }[];
  }[];
  rules?: {
    key: string;
    name: string;
    is_emergency: boolean;
    phase_scope?: string[];
    condition_operator: string;
    cooldown_seconds: number;
    conditions?: {
      condition_type: string;
      slot_key: string | null;
      action_name: string | null;
      operator: string | null;
      threshold_value: string | null;
      status_value: string | null;
      schedule_time: string | null;
      schedule_days?: number[] | null;
    }[];
    actions?: {
      slot_key: string;
      action_name: string;
      target_state: string;
      delay_seconds: number;
    }[];
  }[];
  pipelines?: {
    key: string;
    name: string;
    enabled: boolean;
    phase_scope?: string[];
    sensors?: {
      group_name: string;
      description: string;
      slot_key: string;
      action_name: string;
      inject_as_sensor: boolean;
      inject_as_action: boolean;
      min_value: string | null;
      max_value: string | null;
      compression: string;
      window_minutes: number;
      n?: number | null;
    }[];
    stages?: {
      ordinal: number;
      kind: string;
      ml_model?: { kind: string; name: string; version: string } | null;
      prompt_template?: string | null;
      notify?: string | null;
      execute_condition?: string | null;
    }[];
    triggers?: {
      trigger_type: string;
      slot_key: string | null;
      action_name: string | null;
      operator: string | null;
      threshold_value: string | null;
      schedule_cron: string | null;
      min_interval_sec: number | null;
    }[];
  }[];
}

export function toDraft(bp: RawBlueprint): BlueprintDraft {
  return {
    key: bp.key,
    name: bp.name,
    description: bp.description ?? '',
    context_notes: bp.context_notes ?? '',
    slots: (bp.slots ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      required: s.required,
      min_count: s.min_count ?? 1,
      max_count: s.max_count ?? 1,
      sealed_template:
        typeof s.sealed_template === 'string' ? s.sealed_template : (s.sealed_template?.name ?? ''),
    })),
    params: (bp.params ?? []).map((p) => ({
      key: p.key,
      label: p.label,
      default_value: p.default_value,
      unit: p.unit ?? '',
      user_tunable: p.user_tunable,
    })),
    phases: (bp.phases ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      ordinal: p.ordinal,
      duration_value: p.duration_value,
      duration_unit: p.duration_unit ?? 'days',
      auto_advance: p.auto_advance,
      context_notes: p.context_notes ?? '',
      targets: (p.targets ?? []).map((t) => ({ param_key: t.param_key, value: t.value })),
    })),
    scenes: (bp.scenes ?? []).map((s) => ({
      key: s.key,
      name: s.name,
      phase_scope: s.phase_scope ?? [],
      members: (s.members ?? []).map((m) => ({
        slot_key: m.slot_key,
        action_name: m.action_name,
        target_state: m.target_state,
        delay_seconds: m.delay_seconds,
      })),
    })),
    rules: (bp.rules ?? []).map((r) => {
      const cooldown = secondsToCooldown(r.cooldown_seconds ?? 60);
      return {
        key: r.key,
        name: r.name,
        is_emergency: r.is_emergency,
        phase_scope: r.phase_scope ?? [],
        condition_operator: r.condition_operator,
        cooldown_value: cooldown.value,
        cooldown_unit: cooldown.unit,
        conditions: (r.conditions ?? []).map((c) => ({
          condition_type: c.condition_type,
          slot_key: c.slot_key ?? '',
          action_name: c.action_name ?? '',
          operator: c.operator ?? '<',
          threshold_value: c.threshold_value ?? '',
          status_value: c.status_value ?? '',
          schedule_time: c.schedule_time ?? '',
          schedule_days: c.schedule_days ?? [],
        })),
        actions: (r.actions ?? []).map((a) => ({
          slot_key: a.slot_key,
          action_name: a.action_name,
          target_state: a.target_state,
          delay_seconds: a.delay_seconds,
        })),
      };
    }),
    pipelines: (bp.pipelines ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      enabled: p.enabled,
      phase_scope: p.phase_scope ?? [],
      sensors: (p.sensors ?? []).map((s) => ({
        group_name: s.group_name,
        description: s.description,
        slot_key: s.slot_key,
        action_name: s.action_name,
        inject_as_sensor: s.inject_as_sensor,
        inject_as_action: s.inject_as_action,
        min_value: s.min_value ?? '',
        max_value: s.max_value ?? '',
        compression: s.compression,
        window_minutes: s.window_minutes,
        n: s.n ?? null,
      })),
      stages: (p.stages ?? []).map((s) => ({
        ordinal: s.ordinal,
        kind: s.kind,
        ml_model: s.ml_model ?? null,
        prompt_template: s.prompt_template ?? '',
        notify: s.notify ?? '',
        execute_condition: s.execute_condition ?? '',
      })),
      triggers: (p.triggers ?? []).map((t) => ({
        trigger_type: t.trigger_type,
        slot_key: t.slot_key ?? '',
        action_name: t.action_name ?? '',
        operator: t.operator ?? '<',
        threshold_value: t.threshold_value ?? '',
        schedule_cron: t.schedule_cron ?? '',
        min_interval_sec: t.min_interval_sec,
      })),
    })),
  };
}
