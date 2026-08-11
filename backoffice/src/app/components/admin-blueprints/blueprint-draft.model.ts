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
  // multi-device slot whose template references fan out to every bound device.
  min_count: number;
  max_count: number;
  /**
   * Each device bound here runs its own lifecycle (F11): the user picks a profile per device, and
   * a `per_device` template over this slot materialises one automation each. Leave false for a
   * device the whole setup shares.
   */
  profiled: boolean;
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
  /**
   * A literal ("7") or a param reference (`@param.seedling.days`) — F11.13. The reference is what
   * lets two devices on ONE lifecycle run this phase for different lengths, by each overriding that
   * param for itself; a literal is the same length for all of them.
   */
  duration_value: string;
  duration_unit: string;
  // What ends this phase (F11.x): manual | schedule | rule | pipeline. `advance_ref_key` names the
  // rule/pipeline for the last two; `advance_to_key` is the target phase in this profile ('' = next).
  advance_mode: string;
  advance_ref_key: string;
  advance_to_key: string;
  context_notes: string;
  targets: PhaseTargetDraft[];
}

/**
 * A named lifecycle (F11). Every blueprint that has phases has at least one — a single-lifecycle
 * blueprint is simply the one-profile case, which is why the editor always edits a profile's phases
 * rather than "the phases".
 */
export interface ProfileDraft {
  key: string;
  label: string;
  phases: PhaseDraft[];
}

/** How a template materialises over a multi-device slot (F11.2). */
export const FAN_OUT_MODES = ['combined', 'per_device'];

export interface FanOutDraft {
  fan_out: string;
  fan_out_slot_key: string;
  /** Lifecycles whose devices take part (F11.9); empty = every device bound to the slot. */
  fan_out_profiles: string[];
}

export interface FieldOptionDraft {
  value: string;
  label: string;
  /** Choosing this option also puts the device on this profile — one question, both facts. */
  profile_key: string;
}

/** One question the blueprint asks the user at setup time (F11.6). */
export interface FieldDraft {
  key: string;
  label: string;
  help_text: string;
  input_type: string;
  scope: string;
  slot_key: string;
  required: boolean;
  default_value: string;
  options: FieldOptionDraft[];
}

export const FIELD_TYPES = ['text', 'number', 'select', 'date', 'boolean'];
export const FIELD_SCOPES = ['setup', 'binding'];

export interface SceneMemberDraft {
  slot_key: string;
  action_name: string;
  target_state: string;
  /** Seconds to wait before sending it — a stagger, applied by the platform. */
  delay_seconds: number;
  /**
   * A reference written in place of the numeric delay (F11.14) — `@param.water.stagger_seconds`.
   * Non-empty wins over `delay_seconds`. Held separately rather than widening the number field so
   * the numeric editor keeps working unchanged and a reference cannot be half-parsed into NaN.
   */
  delay_ref: string;
  /**
   * Seconds the DEVICE holds the target state before releasing it (F11.10) — the firmware's own
   * duration auto-off, so the timer survives a restart of anything on this side. Carried as
   * value + unit for the same reason the cooldown is: nobody reads 1800 as half an hour.
   */
  duration_value: number | null;
  duration_unit: string;
  /**
   * A reference written in place of the value+unit pair (F11.14) — `@phase.water.seconds`, so how
   * long to hold follows whichever stage the bound device is in. Non-empty wins over the pair.
   */
  duration_ref: string;
}

export interface SceneDraft extends FanOutDraft {
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
  /**
   * With `schedule_every_minutes`, turns the single time into a repeating window — "06:00 to 17:30,
   * every 10 minutes". Both blank keeps the one-firing-a-day shape every schedule had before.
   */
  schedule_until: string;
  schedule_every_minutes: number | null;
  /** Weekday numbers (0 = Sunday). Empty means every day. */
  schedule_days: number[];
}

export interface RuleActionDraft {
  slot_key: string;
  action_name: string;
  target_state: string;
  /** Seconds to wait before sending it — a stagger, applied by the platform. */
  delay_seconds: number;
  /**
   * A reference written in place of the numeric delay (F11.14) — `@param.water.stagger_seconds`.
   * Non-empty wins over `delay_seconds`. Held separately rather than widening the number field so
   * the numeric editor keeps working unchanged and a reference cannot be half-parsed into NaN.
   */
  delay_ref: string;
  /**
   * Seconds the DEVICE holds the target state before releasing it (F11.10) — the firmware's own
   * duration auto-off, so the timer survives a restart of anything on this side. Carried as
   * value + unit for the same reason the cooldown is: nobody reads 1800 as half an hour.
   */
  duration_value: number | null;
  duration_unit: string;
  /**
   * A reference written in place of the value+unit pair (F11.14) — `@phase.water.seconds`, so how
   * long to hold follows whichever stage the bound device is in. Non-empty wins over the pair.
   */
  duration_ref: string;
}

export interface RuleDraft extends FanOutDraft {
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
  /** Same shape a rule condition uses; `schedule_cron` was never evaluated and is gone. */
  schedule_time: string;
  schedule_until: string;
  schedule_every_minutes: number | null;
  schedule_days: number[];
  /**
   * How long the pipeline must wait before it may run again, whatever fires it. Carried as a
   * value + unit exactly like a rule's cooldown, because "43200" is not a thing a person reads —
   * stored as seconds, which is what the column holds.
   */
  min_interval_value: number | null;
  min_interval_unit: string;
}

export interface PipelineDraft extends FanOutDraft {
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
  /**
   * A **static** setup: no slot in it has phases, so nothing is scheduled anywhere (F11.8). It
   * still starts and stops; it simply has no lifecycle to walk. Publish refuses a static blueprint
   * that declares phases, and a non-static one that declares none.
   */
  is_static: boolean;
  context_notes: string;
  slots: SlotDraft[];
  params: ParamDraft[];
  /** Questions the user answers when they set this up (F11.6), addressable as `@field.key`. */
  fields: FieldDraft[];
  /** Lifecycles (F11). Phases hang off one of these, never off the blueprint. */
  profiles: ProfileDraft[];
  scenes: SceneDraft[];
  rules: RuleDraft[];
  pipelines: PipelineDraft[];
}

/**
 * The phases of the given lifecycles, deduped by key and skipping keyless ones. A scope names phase
 * KEYS, so two lifecycles declaring the same key are one scopable phase, not two.
 */
export function phasesOf(profiles: ProfileDraft[]): PhaseDraft[] {
  const seen = new Set<string>();
  const out: PhaseDraft[] = [];
  for (const profile of profiles) {
    for (const phase of profile.phases) {
      if (!phase.key || seen.has(phase.key)) continue;
      seen.add(phase.key);
      out.push(phase);
    }
  }
  return out;
}

/** Every phase across every lifecycle, deduped by key — what a `phase_scope` may name. */
export function allDraftPhases(d: BlueprintDraft): PhaseDraft[] {
  return phasesOf(d.profiles);
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

// ── Positional values that may be a reference (F11.14) ────────────────────────
//
// `duration_seconds` and `delay_seconds` hold either a number of seconds or a reference. The
// builder edits the numeric case as a value+unit pair, which cannot represent "@phase.water.seconds"
// at all — so the reference is carried in its own field and these two functions are the only place
// the two representations meet. Without them, loading a blueprint that uses a reference and pressing
// Save would send back a blank duration: the round-trip, not the editor, is what loses it.

/** Is this stored value a reference rather than a number? */
function isRef(value: unknown): value is string {
  return typeof value === 'string' && value.trim().startsWith('@');
}

/** Draft → document: the reference wins when set, else the number the pair converts to. */
function positionalOut(ref: string, numeric: number | undefined): string | number | undefined {
  const trimmed = ref?.trim();
  if (trimmed) return trimmed;
  return numeric;
}

/** Document → draft: a reference goes to `*_ref`, a number to the value+unit pair. */
function positionalIn(
  stored: string | number | null | undefined,
  kind: 'delay',
): { delay_seconds: number; delay_ref: string };
function positionalIn(
  stored: string | number | null | undefined,
  kind: 'duration',
): { duration_value: number | null; duration_unit: string; duration_ref: string };
function positionalIn(
  stored: string | number | null | undefined,
  kind: 'delay' | 'duration',
): Record<string, unknown> {
  const ref = isRef(stored) ? stored.trim() : '';
  const seconds = ref ? null : Number(stored ?? 0);
  const usable = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;

  if (kind === 'delay') return { delay_seconds: usable ?? 0, delay_ref: ref };
  const pair = usable === null ? null : secondsToCooldown(usable);
  return {
    duration_value: pair?.value ?? null,
    duration_unit: pair?.unit ?? 'minutes',
    duration_ref: ref,
  };
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
    is_static: false,
    context_notes: '',
    slots: [],
    params: [],
    fields: [],
    // One lifecycle to start with: the common blueprint has exactly one, and making the author
    // create it first would be ceremony for the case that needs none.
    profiles: [{ key: 'default', label: 'Default', phases: [] }],
    scenes: [],
    rules: [],
    pipelines: [],
  };
}

export function newSlot(): SlotDraft {
  return {
    key: '',
    label: '',
    required: true,
    min_count: 1,
    max_count: 1,
    profiled: false,
    sealed_template: '',
  };
}
export function newProfile(): ProfileDraft {
  return { key: '', label: '', phases: [] };
}
export function newField(): FieldDraft {
  return {
    key: '',
    label: '',
    help_text: '',
    input_type: 'text',
    scope: 'setup',
    slot_key: '',
    required: false,
    default_value: '',
    options: [],
  };
}
export function newFieldOption(): FieldOptionDraft {
  return { value: '', label: '', profile_key: '' };
}
export function newParam(): ParamDraft {
  return { key: '', label: '', default_value: '', unit: '', user_tunable: true };
}
export function newPhase(ordinal: number): PhaseDraft {
  return {
    key: '',
    name: '',
    ordinal,
    duration_value: '',
    duration_unit: 'days',
    advance_mode: 'manual',
    advance_ref_key: '',
    advance_to_key: '',
    context_notes: '',
    targets: [],
  };
}
export function newScene(): SceneDraft {
  return {
    key: '',
    name: '',
    phase_scope: [],
    fan_out: 'combined',
    fan_out_slot_key: '',
    fan_out_profiles: [],
    members: [],
  };
}
export function newSceneMember(): SceneMemberDraft {
  return {
    slot_key: '',
    action_name: '',
    target_state: '',
    delay_seconds: 0,
    delay_ref: '',
    duration_value: null,
    duration_unit: 'minutes',
    duration_ref: '',
  };
}
export function newRule(): RuleDraft {
  return {
    key: '',
    name: '',
    is_emergency: false,
    phase_scope: [],
    fan_out: 'combined',
    fan_out_slot_key: '',
    fan_out_profiles: [],
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
    schedule_until: '',
    schedule_every_minutes: null,
    schedule_days: [],
  };
}
export function newRuleAction(): RuleActionDraft {
  return {
    slot_key: '',
    action_name: '',
    target_state: '',
    delay_seconds: 0,
    delay_ref: '',
    duration_value: null,
    duration_unit: 'minutes',
    duration_ref: '',
  };
}
export function newPipeline(): PipelineDraft {
  return {
    key: '',
    name: '',
    enabled: true,
    phase_scope: [],
    fan_out: 'combined',
    fan_out_slot_key: '',
    fan_out_profiles: [],
    sensors: [],
    stages: [],
    triggers: [],
  };
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
    schedule_time: '08:00',
    schedule_until: '',
    schedule_every_minutes: null,
    schedule_days: [],
    min_interval_value: null,
    min_interval_unit: 'minutes',
  };
}

// ─── Draft ⇄ import document ─────────────────────────────────────────────────────────────────

const blank = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

/** Fan-out columns; a combined template carries no slot key, so a stale one is not sent (F11.2). */
function fanOutDoc(t: FanOutDraft): {
  fan_out: string;
  fan_out_slot_key?: string;
  fan_out_profiles?: string[];
} {
  const profiles = t.fan_out_profiles ?? [];
  // The slot key matters to a combined template too once a lifecycle selection narrows which of
  // its devices the single automation covers (F11.9) — it is only dropped when nothing reads it.
  const keepsSlot = t.fan_out === 'per_device' || profiles.length > 0;
  return {
    fan_out: t.fan_out === 'per_device' ? 'per_device' : 'combined',
    fan_out_slot_key: keepsSlot ? t.fan_out_slot_key || undefined : undefined,
    fan_out_profiles: profiles.length > 0 ? profiles : undefined,
  };
}

/** Strip the form's empty strings back to absent fields so the saved document stays minimal. */
export function toDocument(d: BlueprintDraft): unknown {
  return {
    key: d.key.trim(),
    name: d.name.trim(),
    description: blank(d.description),
    is_static: d.is_static,
    context_notes: blank(d.context_notes),
    slots: d.slots.map((s, i) => ({
      key: s.key.trim(),
      label: s.label.trim(),
      required: s.required,
      min_count: s.min_count,
      max_count: s.max_count,
      profiled: s.profiled,
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
    fields: d.fields.map((f, i) => ({
      key: f.key.trim(),
      label: f.label.trim(),
      help_text: blank(f.help_text),
      input_type: f.input_type,
      scope: f.scope,
      slot_key: f.scope === 'binding' ? blank(f.slot_key) : undefined,
      required: f.required,
      default_value: blank(f.default_value),
      sort_order: i,
      options:
        f.input_type === 'select'
          ? f.options
              .filter((o) => o.value.trim())
              .map((o, j) => ({
                value: o.value.trim(),
                label: o.label.trim() || o.value.trim(),
                profile_key: blank(o.profile_key),
                sort_order: j,
              }))
          : [],
    })),
    // A profile with no phases would fail publish and means nothing anyway — dropped rather than
    // sent, so an author who added a lifecycle and changed their mind is not blocked by it.
    // A static setup has no lifecycle by definition, so its profiles are not sent even if the
    // author left one behind from before they ticked the box.
    profiles: (d.is_static ? [] : d.profiles)
      .filter((pr) => pr.phases.length > 0)
      .map((pr, i) => ({
        key: pr.key.trim(),
        label: pr.label.trim() || pr.key.trim(),
        sort_order: i,
        phases: pr.phases.map((p) => ({
          key: p.key.trim(),
          name: p.name.trim(),
          ordinal: p.ordinal,
          duration_value: p.duration_value?.trim() || undefined,
          duration_unit: p.duration_value?.trim() ? p.duration_unit : undefined,
          advance_mode: p.advance_mode,
          // Only a rule/pipeline trigger carries a reference; an empty target key means "next".
          advance_ref_key:
            p.advance_mode === 'rule' || p.advance_mode === 'pipeline'
              ? p.advance_ref_key || undefined
              : undefined,
          advance_to_key: p.advance_to_key || undefined,
          context_notes: blank(p.context_notes),
          targets: p.targets
            .filter((t) => t.param_key)
            .map((t) => ({ param_key: t.param_key, value: t.value })),
        })),
      })),
    scenes: d.scenes.map((s, i) => ({
      key: s.key.trim(),
      name: s.name.trim(),
      sort_order: i,
      phase_scope: [...s.phase_scope],
      ...fanOutDoc(s),
      members: s.members.map((m, j) => ({
        slot_key: m.slot_key,
        action_name: m.action_name,
        target_state: m.target_state,
        sort_order: j,
        delay_seconds: positionalOut(m.delay_ref, m.delay_seconds),
        duration_seconds: positionalOut(
          m.duration_ref,
          m.duration_value == null || m.duration_value <= 0
            ? undefined
            : cooldownToSeconds(m.duration_value, m.duration_unit),
        ),
      })),
    })),
    rules: d.rules.map((r) => ({
      key: r.key.trim(),
      name: r.name.trim(),
      is_emergency: r.is_emergency,
      phase_scope: [...r.phase_scope],
      ...fanOutDoc(r),
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
        // A window only means something with both halves; sending one alone would be rejected at
        // publish, so the form's half-filled state simply reads as "no window".
        schedule_until:
          c.condition_type === 'schedule' && c.schedule_until && c.schedule_every_minutes
            ? c.schedule_until
            : undefined,
        schedule_every_minutes:
          c.condition_type === 'schedule' && c.schedule_until && c.schedule_every_minutes
            ? c.schedule_every_minutes
            : undefined,
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
        delay_seconds: positionalOut(a.delay_ref, a.delay_seconds),
        duration_seconds: positionalOut(
          a.duration_ref,
          a.duration_value == null || a.duration_value <= 0
            ? undefined
            : cooldownToSeconds(a.duration_value, a.duration_unit),
        ),
      })),
    })),
    pipelines: d.pipelines.map((p) => ({
      key: p.key.trim(),
      name: p.name.trim(),
      enabled: p.enabled,
      phase_scope: [...p.phase_scope],
      ...fanOutDoc(p),
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
        schedule_time: t.trigger_type === 'schedule' ? blank(t.schedule_time) : undefined,
        schedule_until:
          t.trigger_type === 'schedule' && t.schedule_until && t.schedule_every_minutes
            ? t.schedule_until
            : undefined,
        schedule_every_minutes:
          t.trigger_type === 'schedule' && t.schedule_until && t.schedule_every_minutes
            ? t.schedule_every_minutes
            : undefined,
        schedule_days:
          t.trigger_type === 'schedule' && t.schedule_days.length > 0
            ? [...t.schedule_days].sort((a, b) => a - b)
            : undefined,
        min_interval_sec:
          t.min_interval_value == null || t.min_interval_value <= 0
            ? undefined
            : cooldownToSeconds(t.min_interval_value, t.min_interval_unit),
      })),
    })),
  };
}

/** The server's row shape, read back into the form. Only the fields the editor owns. */
interface RawPhase {
  key: string;
  name: string;
  ordinal: number;
  /** Text since F11.13 — a literal or an `@param.` reference. */
  duration_value: string | null;
  duration_unit: string | null;
  advance_mode?: string;
  advance_ref_key?: string | null;
  advance_to_key?: string | null;
  context_notes: string | null;
  targets?: { param_key: string; value: string }[];
}

export interface RawBlueprint {
  key: string;
  name: string;
  description: string | null;
  is_static?: boolean;
  context_notes: string | null;
  slots?: {
    key: string;
    label: string;
    required: boolean;
    min_count?: number;
    max_count?: number;
    profiled?: boolean;
    // Two shapes reach here: the API's getBlueprint returns the relation as an object, while a
    // pasted/seed *document* names it as a plain string. toDraft accepts both.
    sealed_template?: string | { name: string };
  }[];
  fields?: {
    key: string;
    label: string;
    help_text?: string | null;
    input_type?: string;
    scope?: string;
    slot_key?: string | null;
    required?: boolean;
    default_value?: string | null;
    options?: { value: string; label: string; profile_key?: string | null }[];
  }[];
  params?: {
    key: string;
    label: string;
    default_value: string;
    unit: string | null;
    user_tunable: boolean;
  }[];
  /**
   * A saved blueprint always returns `profiles`. `phases` remains accepted because a *document*
   * may still be written in the single-lifecycle shorthand — pasted JSON, a seed file — and the
   * import endpoint normalises it the same way this does.
   */
  profiles?: {
    key: string;
    label: string;
    phases?: RawPhase[];
  }[];
  phases?: RawPhase[];
  scenes?: {
    key: string;
    name: string;
    phase_scope?: string[];
    fan_out?: string;
    fan_out_slot_key?: string | null;
    fan_out_profiles?: string[] | null;
    members?: {
      slot_key: string;
      action_name: string;
      target_state: string;
      // Both may arrive as a number or as a reference string (F11.14).
      delay_seconds: number | string | null;
      duration_seconds?: number | string | null;
    }[];
  }[];
  rules?: {
    key: string;
    name: string;
    is_emergency: boolean;
    phase_scope?: string[];
    fan_out?: string;
    fan_out_slot_key?: string | null;
    fan_out_profiles?: string[] | null;
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
      schedule_until?: string | null;
      schedule_every_minutes?: number | null;
      schedule_days?: number[] | null;
    }[];
    actions?: {
      slot_key: string;
      action_name: string;
      target_state: string;
      // Both may arrive as a number or as a reference string (F11.14).
      delay_seconds: number | string | null;
      duration_seconds?: number | string | null;
    }[];
  }[];
  pipelines?: {
    key: string;
    name: string;
    enabled: boolean;
    phase_scope?: string[];
    fan_out?: string;
    fan_out_slot_key?: string | null;
    fan_out_profiles?: string[] | null;
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
      schedule_time?: string | null;
      schedule_until?: string | null;
      schedule_every_minutes?: number | null;
      schedule_days?: number[];
      min_interval_sec: number | null;
    }[];
  }[];
}

function toPhaseDraft(p: RawPhase): PhaseDraft {
  return {
    key: p.key,
    name: p.name,
    ordinal: p.ordinal,
    duration_value: p.duration_value ?? '',
    duration_unit: p.duration_unit ?? 'days',
    advance_mode: p.advance_mode ?? 'manual',
    advance_ref_key: p.advance_ref_key ?? '',
    advance_to_key: p.advance_to_key ?? '',
    context_notes: p.context_notes ?? '',
    targets: (p.targets ?? []).map((t) => ({ param_key: t.param_key, value: t.value })),
  };
}

/**
 * Lifecycles, from either shape the source may be in — the saved `profiles`, or a document written
 * in the single-lifecycle `phases` shorthand. A blueprint with neither still gets one empty profile
 * so the editor always has somewhere to put a phase.
 */
function toProfileDrafts(bp: RawBlueprint): ProfileDraft[] {
  if (bp.profiles?.length) {
    return bp.profiles.map((pr) => ({
      key: pr.key,
      label: pr.label,
      phases: (pr.phases ?? []).map(toPhaseDraft),
    }));
  }
  return [
    { key: 'default', label: 'Default', phases: (bp.phases ?? []).map(toPhaseDraft) },
  ];
}

export function toDraft(bp: RawBlueprint): BlueprintDraft {
  return {
    key: bp.key,
    name: bp.name,
    description: bp.description ?? '',
    is_static: bp.is_static ?? false,
    context_notes: bp.context_notes ?? '',
    slots: (bp.slots ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      required: s.required,
      min_count: s.min_count ?? 1,
      max_count: s.max_count ?? 1,
      profiled: s.profiled ?? false,
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
    fields: (bp.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      help_text: f.help_text ?? '',
      input_type: f.input_type ?? 'text',
      scope: f.scope ?? 'setup',
      slot_key: f.slot_key ?? '',
      required: f.required ?? false,
      default_value: f.default_value ?? '',
      options: (f.options ?? []).map((o) => ({
        value: o.value,
        label: o.label,
        profile_key: o.profile_key ?? '',
      })),
    })),
    profiles: toProfileDrafts(bp),
    scenes: (bp.scenes ?? []).map((s) => ({
      key: s.key,
      name: s.name,
      phase_scope: s.phase_scope ?? [],
      fan_out: s.fan_out ?? 'combined',
      fan_out_slot_key: s.fan_out_slot_key ?? '',
      fan_out_profiles: s.fan_out_profiles ?? [],
      members: (s.members ?? []).map((m) => ({
        slot_key: m.slot_key,
        action_name: m.action_name,
        target_state: m.target_state,
        ...positionalIn(m.delay_seconds, 'delay'),
        ...positionalIn(m.duration_seconds, 'duration'),
      })),
    })),
    rules: (bp.rules ?? []).map((r) => {
      const cooldown = secondsToCooldown(r.cooldown_seconds ?? 60);
      return {
        key: r.key,
        name: r.name,
        is_emergency: r.is_emergency,
        phase_scope: r.phase_scope ?? [],
        fan_out: r.fan_out ?? 'combined',
        fan_out_slot_key: r.fan_out_slot_key ?? '',
        fan_out_profiles: r.fan_out_profiles ?? [],
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
          schedule_until: c.schedule_until ?? '',
          schedule_every_minutes: c.schedule_every_minutes ?? null,
          schedule_days: c.schedule_days ?? [],
        })),
        actions: (r.actions ?? []).map((a) => ({
          slot_key: a.slot_key,
          action_name: a.action_name,
          target_state: a.target_state,
          ...positionalIn(a.delay_seconds, 'delay'),
          ...positionalIn(a.duration_seconds, 'duration'),
        })),
      };
    }),
    pipelines: (bp.pipelines ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      enabled: p.enabled,
      phase_scope: p.phase_scope ?? [],
      fan_out: p.fan_out ?? 'combined',
      fan_out_slot_key: p.fan_out_slot_key ?? '',
      fan_out_profiles: p.fan_out_profiles ?? [],
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
        schedule_time: t.schedule_time ?? '',
        schedule_until: t.schedule_until ?? '',
        schedule_every_minutes: t.schedule_every_minutes ?? null,
        schedule_days: t.schedule_days ?? [],
        ...(() => {
          // Seconds → the largest unit that divides evenly, so a stored 43200 reads "12 hours".
          const g = t.min_interval_sec ? secondsToCooldown(t.min_interval_sec) : null;
          return { min_interval_value: g?.value ?? null, min_interval_unit: g?.unit ?? 'minutes' };
        })(),
      })),
    })),
  };
}
