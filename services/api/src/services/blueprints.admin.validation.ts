import { db } from '../db';
import {
  isParamRef,
  parseParamRef,
  positionalError,
  positionalText,
  validateParamKey,
  validateParamRefs,
  findParamRefs,
  validateSchedule,
  type ScheduleSpec,
} from '@lattice/params';
import {
  blueprintInclude,
  notFound,
  type BlueprintDoc,
  type FanOutDoc,
} from './blueprints.admin.types';
import { profileDocs } from './blueprints.admin.persist';

/** A document's fan-out columns as the stored rows would have them — undefined means `combined`. */
function docFanOut(t: FanOutDoc): {
  fan_out: string;
  fan_out_slot_key: string | null;
  fan_out_profiles: string[];
} {
  return {
    fan_out: t.fan_out ?? 'combined',
    fan_out_slot_key: t.fan_out_slot_key ?? null,
    fan_out_profiles: t.fan_out_profiles ?? [],
  };
}

// Blueprint publish/validate gate. A draft may be incomplete, but publish refuses anything a
// derive could not satisfy. Catching a bad reference here matters because at evaluation time an
// undeclared `@param.x` is indistinguishable from a deleted one — both just silently stop the rule
// from firing.
//
// Two callers feed the same checks: the stored blueprint (publish, and validating a saved row) and
// an unsaved document straight from the builder. They MUST run the same checks — a builder that
// validates something other than what you are looking at is worse than no validate button — so
// both normalize to `ValidationShape` and run `problemsFor`.

/**
 * What validation actually needs, independent of where it came from (a stored row vs a document).
 */
interface ValidationShape {
  /** A static setup: no slot has phases, so nothing in it is scheduled at all (F11.8). */
  is_static: boolean;
  slots: {
    key: string;
    min_count: number;
    max_count: number;
    profiled: boolean;
    sealed_template: { name: string; status: string; entries: { mqtt_action_name: string }[] };
  }[];
  params: { key: string; default_value: string }[];
  /** The dynamic form (F11.6) — what `@field.x` may address, and what the derive wizard asks. */
  fields: {
    key: string;
    input_type: string;
    scope: string;
    slot_key: string | null;
    required: boolean;
    default_value: string | null;
    options: { value: string; profile_key: string | null }[];
  }[];
  /**
   * Lifecycles, each owning its phases (F11). Uniqueness of a phase key or ordinal is a
   * **per-profile** property: two profiles legitimately declare the same key at the same ordinal,
   * and checking across the blueprint would reject every blueprint with more than one lifecycle.
   */
  profiles: {
    key: string;
    phases: {
      key: string;
      ordinal: number;
      advance_mode: string;
      advance_ref_key: string | null;
      advance_to_key: string | null;
      duration_value: string | null;
      context_notes: string | null;
      targets: { param_key: string }[];
    }[];
  }[];
  scenes: {
    key: string;
    phase_scope: string[];
    fan_out: string;
    fan_out_slot_key: string | null;
    fan_out_profiles: string[];
    members: {
      slot_key: string;
      action_name: string;
      target_state: string;
      // Text since F11.14 — a literal or a reference, checked like any other value position.
      delay_seconds: string | null;
      duration_seconds: string | null;
    }[];
  }[];
  rules: {
    key: string;
    phase_scope: string[];
    fan_out: string;
    fan_out_slot_key: string | null;
    fan_out_profiles: string[];
    conditions: {
      condition_type: string;
      slot_key: string | null;
      action_name: string | null;
      status_value: string | null;
      threshold_value: string | null;
      schedule_time: string | null;
      schedule_until: string | null;
      schedule_every_minutes: number | null;
      schedule_days: number[];
    }[];
    actions: {
      slot_key: string;
      action_name: string;
      target_state: string;
      delay_seconds: string | null;
      duration_seconds: string | null;
    }[];
  }[];
  pipelines: {
    key: string;
    phase_scope: string[];
    fan_out: string;
    fan_out_slot_key: string | null;
    fan_out_profiles: string[];
    stages: { ordinal: number; kind: string; has_model: boolean; prompt_template: string | null }[];
    sensors: {
      slot_key: string;
      action_name: string;
      min_value: string | null;
      max_value: string | null;
    }[];
    triggers: {
      trigger_type: string;
      slot_key: string | null;
      action_name: string | null;
      threshold_value: string | null;
      schedule_time: string | null;
      schedule_until: string | null;
      schedule_every_minutes: number | null;
      schedule_days: number[];
    }[];
  }[];
}

/** A schedule-bearing row as the one shared validator wants it. */
function scheduleOf(row: {
  schedule_time: string | null;
  schedule_until: string | null;
  schedule_every_minutes: number | null;
  schedule_days: number[];
}): ScheduleSpec {
  return {
    time: row.schedule_time,
    until: row.schedule_until,
    everyMinutes: row.schedule_every_minutes,
    days: row.schedule_days,
  };
}

/**
 * What is wrong with a phase's duration, if anything (F11.13).
 *
 * Three refusals, all of which would otherwise be silent — `phaseDurationSeconds` treats anything
 * it cannot read as "no duration", so a bad duration does not error, it just means the phase never
 * advances on its clock:
 *
 *  1. a literal that is not a positive number;
 *  2. a reference to something undeclared, or of a kind that cannot answer with a number;
 *  3. **a phase whose own duration is set by its own targets** — the loop. "This phase lasts as
 *     long as `x` says, and entering this phase sets `x`" is answerable, but it means the duration
 *     changes the moment the phase begins, which is never what someone writing it intends.
 */
function durationErrors(
  phase: { duration_value: string | null; targets: { param_key: string }[] },
  paramKeys: Set<string>,
  fieldKeys: Set<string>,
): string[] {
  const value = phase.duration_value!;
  const problems: string[] = [];

  if (!isParamRef(value)) {
    const n = Number(value.trim());
    if (!Number.isFinite(n) || n <= 0) {
      problems.push(`"${value}" is neither a positive number nor a reference`);
    }
    return problems;
  }

  const ref = parseParamRef(value);
  if (!ref) {
    problems.push(`"${value}" is not a reference this platform understands`);
    return problems;
  }
  // `@phase.x` names the CURRENT phase's target for x — inside a phase's own duration that is the
  // loop below by another spelling, and there is no phase to read it against before entry anyway.
  if (ref.kind === 'phase') {
    problems.push('a duration cannot be `@phase.` — it is read before the phase is entered');
    return problems;
  }
  const known = ref.kind === 'field' ? fieldKeys : paramKeys;
  if (!known.has(ref.key)) {
    problems.push(`"${value}" references a ${ref.kind} this blueprint does not declare`);
    return problems;
  }
  if (ref.kind === 'param' && phase.targets.some((t) => t.param_key === ref.key)) {
    problems.push(
      `it reads "${ref.key}", which this same phase sets — entering the phase would change its own length`,
    );
  }
  return problems;
}

// Every value position that may hold an `@param.` / `@phase.` reference, so validation and the
// eventual derive agree on where references are legal.
function problemsFor(bp: ValidationShape): string[] {
  const problems: string[] = [];
  const paramKeys = new Set(bp.params.map((p) => p.key));
  const fieldKeys = new Set(bp.fields.map((f) => f.key));

  if (bp.slots.length === 0) problems.push('a blueprint needs at least one slot');

  // A draft sealed template has no resolved config to materialize, so a derive would produce a
  // device with no actions — reject at publish rather than at derive time.
  for (const slot of bp.slots) {
    if (slot.sealed_template.status !== 'released') {
      problems.push(
        `slot "${slot.key}" targets sealed template "${slot.sealed_template.name}", which is ${slot.sealed_template.status}, not released`,
      );
    }
    if (slot.min_count > slot.max_count) {
      problems.push(`slot "${slot.key}" has min_count > max_count`);
    }
  }

  // Flattened for the questions that do not care which lifecycle a phase belongs to.
  const everyPhase = bp.profiles.flatMap((pr) => pr.phases);
  const phaseSetKeys = new Set(everyPhase.flatMap((p) => p.targets.map((t) => t.param_key)));
  for (const param of bp.params) {
    const err = validateParamKey(param.key);
    if (err) problems.push(`param: ${err}`);
    // A param with no default that no phase sets can never resolve: every reference to it comes
    // back null, and a rule that references it fails closed and silently never fires.
    if (!param.default_value.trim() && !phaseSetKeys.has(param.key)) {
      problems.push(
        `param "${param.key}" has no default and no phase sets it, so it can never resolve`,
      );
    }
  }

  const profileKeys = new Set<string>();
  for (const profile of bp.profiles) {
    if (profileKeys.has(profile.key)) problems.push(`duplicate profile "${profile.key}"`);
    profileKeys.add(profile.key);
    if (profile.phases.length === 0) {
      problems.push(`profile "${profile.key}" declares no phases, so nothing can follow it`);
    }
  }

  // A profiled slot's bindings each pick a profile, so there has to be one to pick.
  for (const slot of bp.slots) {
    if (slot.profiled && bp.profiles.length === 0) {
      problems.push(
        `slot "${slot.key}" is profiled but the blueprint declares no profiles, so nothing can be chosen for it`,
      );
    }
  }

  // …and the converse. Nothing *chooses* a lifecycle unless some slot is profiled, so a setup with
  // no profiled slot silently follows the first one and the rest are dead weight — the shape an
  // author lands in by adding a second lifecycle and forgetting to tick the slot. Both derive and
  // the setup page take `profiles[0]`, so this publishes clean and then quietly ignores the rest.
  if (!bp.slots.some((s) => s.profiled) && bp.profiles.length > 1) {
    problems.push(
      `this setup declares ${bp.profiles.length} lifecycles but no slot whose devices choose between them — mark a multi-device slot as per-device, or keep a single lifecycle`,
    );
  }

  // ── Static (F11.8) ────────────────────────────────────────────────────────────────────────
  //
  // The flag and the content have to agree, checked BOTH ways. A blueprint marked static that
  // still declares a lifecycle would show a phase track it says it does not have; one that
  // declares no lifecycle and is not marked static is indistinguishable from a draft whose author
  // simply has not added the phases yet — and publishing that hides a genuine omission.
  if (bp.is_static && bp.profiles.length > 0) {
    problems.push(
      `this setup is marked static, so no slot in it may have phases — remove its ${bp.profiles.length} lifecycle(s) or untick static`,
    );
  }
  if (!bp.is_static && bp.profiles.length === 0) {
    problems.push(
      'this setup declares no phases — mark it static if nothing in it is scheduled, or give it a lifecycle',
    );
  }

  // ── The dynamic form (F11.6) ──────────────────────────────────────────────────────────────
  const seenFieldKeys = new Set<string>();
  const FIELD_TYPES = ['text', 'number', 'select', 'date', 'boolean'];
  for (const field of bp.fields) {
    if (seenFieldKeys.has(field.key)) problems.push(`duplicate field "${field.key}"`);
    seenFieldKeys.add(field.key);
    // Same grammar as a param key, because both are addressed the same way in a reference.
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(field.key)) {
      problems.push(
        `field "${field.key}" is not a valid key (letters, digits, underscore, dot-separated)`,
      );
    }
    if (!FIELD_TYPES.includes(field.input_type)) {
      problems.push(
        `field "${field.key}" has unknown input_type "${field.input_type}" (use ${FIELD_TYPES.join(', ')})`,
      );
    }
    if (field.scope !== 'setup' && field.scope !== 'binding') {
      problems.push(
        `field "${field.key}" has unknown scope "${field.scope}" (use setup or binding)`,
      );
    }
    if (field.scope === 'binding') {
      if (!field.slot_key) {
        problems.push(`field "${field.key}" is asked per device but names no slot`);
      } else if (!bp.slots.some((s) => s.key === field.slot_key)) {
        problems.push(
          `field "${field.key}" is asked per device of slot "${field.slot_key}", which is not declared`,
        );
      }
    }
    if (field.input_type === 'select' && field.options.length === 0) {
      problems.push(`field "${field.key}" is a select with no options`);
    }
    if (field.input_type !== 'select' && field.options.length > 0) {
      problems.push(`field "${field.key}" is a ${field.input_type} field but declares options`);
    }
    const seenValues = new Set<string>();
    for (const option of field.options) {
      if (seenValues.has(option.value)) {
        problems.push(`field "${field.key}" has duplicate option "${option.value}"`);
      }
      seenValues.add(option.value);
      // The load-bearing bit: an option may choose the binding's lifecycle — so it must name one.
      if (option.profile_key && !profileKeys.has(option.profile_key)) {
        problems.push(
          `field "${field.key}" option "${option.value}" selects profile "${option.profile_key}", which is not declared` +
            (profileKeys.size ? ` (has: ${[...profileKeys].join(', ')})` : ''),
        );
      }
    }
    // A field that picks the profile only makes sense where a profile is picked at all.
    if (field.options.some((o) => o.profile_key)) {
      const slot = bp.slots.find((s) => s.key === field.slot_key);
      if (field.scope !== 'binding' || !slot?.profiled) {
        problems.push(
          `field "${field.key}" has options that select a profile, so it must be asked per device of a profiled slot`,
        );
      }
    }
  }

  // Ordinals and keys are unique *within* a lifecycle, not across the blueprint.
  for (const profile of bp.profiles) {
    const ordinals = new Set<number>();
    const keys = new Set<string>();
    for (const phase of profile.phases) {
      if (ordinals.has(phase.ordinal)) {
        problems.push(`profile "${profile.key}" has duplicate phase ordinal ${phase.ordinal}`);
      }
      ordinals.add(phase.ordinal);
      if (keys.has(phase.key)) {
        problems.push(`profile "${profile.key}" has duplicate phase "${phase.key}"`);
      }
      keys.add(phase.key);
    }
  }

  for (const phase of everyPhase) {
    if (phase.advance_mode === 'schedule' && !phase.duration_value) {
      problems.push(`phase "${phase.key}" advances on a schedule but has no duration`);
    }
    // A duration is a literal or a reference (F11.13). Both are checked here because both fail the
    // same silent way at evaluation time: `phaseDurationSeconds` reads anything unparseable as "no
    // duration", so a typo does not error — the phase simply never advances.
    if (phase.duration_value) {
      const durationProblems = durationErrors(phase, paramKeys, fieldKeys);
      for (const p of durationProblems) problems.push(`phase "${phase.key}" duration: ${p}`);
    }
    for (const target of phase.targets) {
      if (!paramKeys.has(target.param_key)) {
        problems.push(
          `phase "${phase.key}" sets "${target.param_key}", which is not a declared param`,
        );
      }
    }
    for (const ref of findParamRefs(phase.context_notes)) {
      if (ref.kind === 'param' && !paramKeys.has(ref.key)) {
        problems.push(`phase "${phase.key}" notes reference undeclared param "${ref.key}"`);
      }
    }
  }

  // What ends each phase (F11.x). The trigger is the phase's own: a rule/pipeline it names must
  // exist, must sit at the phase's lifecycle level (a per-device phase ⇒ a per_device decider that
  // covers this profile; a setup phase ⇒ a combined one), and advance_to_key, when set, is a phase
  // in the SAME profile. Which level applies is a blueprint-wide fact: once any slot is profiled the
  // setup has no lifecycle of its own, so every phase belongs to a bound device.
  const ADVANCE_MODES = new Set(['manual', 'schedule', 'rule', 'pipeline']);
  const anyProfiledSlot = bp.slots.some((s) => s.profiled);
  for (const profile of bp.profiles) {
    const profilePhaseKeys = new Set(profile.phases.map((p) => p.key));
    for (const phase of profile.phases) {
      if (!ADVANCE_MODES.has(phase.advance_mode)) {
        problems.push(`phase "${phase.key}" has an unknown advance mode "${phase.advance_mode}"`);
      }
      if (phase.advance_mode === 'rule' || phase.advance_mode === 'pipeline') {
        const isRule = phase.advance_mode === 'rule';
        const noun = isRule ? 'rule' : 'pipeline';
        const decider = isRule
          ? bp.rules.find((r) => r.key === phase.advance_ref_key)
          : bp.pipelines.find((p) => p.key === phase.advance_ref_key);
        if (!phase.advance_ref_key) {
          problems.push(`phase "${phase.key}" advances by a ${noun} but names none`);
        } else if (!decider) {
          problems.push(
            `phase "${phase.key}" advances by ${noun} "${phase.advance_ref_key}", which is not a declared ${noun}`,
          );
        } else if (anyProfiledSlot) {
          if (decider.fan_out !== 'per_device') {
            problems.push(
              `phase "${phase.key}" is a per-device lifecycle, so the ${noun} that advances it ("${decider.key}") must be per-device`,
            );
          } else if (
            decider.fan_out_profiles.length > 0 &&
            !decider.fan_out_profiles.includes(profile.key)
          ) {
            problems.push(
              `the ${noun} "${decider.key}" advances phase "${phase.key}" but does not apply to its profile "${profile.key}"`,
            );
          }
        } else if (decider.fan_out === 'per_device') {
          problems.push(
            `phase "${phase.key}" is a setup lifecycle, so the ${noun} that advances it ("${decider.key}") must not be per-device`,
          );
        }
      }
      if (phase.advance_to_key) {
        if (phase.advance_to_key === phase.key) {
          problems.push(`phase "${phase.key}" advances to itself`);
        } else if (!profilePhaseKeys.has(phase.advance_to_key)) {
          problems.push(
            `phase "${phase.key}" advances to "${phase.advance_to_key}", which is not a phase of profile "${profile.key}"`,
          );
        }
      }
    }
  }

  // Slot + action addressing and reference legality, per value-bearing row.
  //
  // The addressing check is the one that decides whether a derive can succeed at all: derive
  // resolves (slot_key, action_name) → user_device_action by mqtt_action_name, and those rows
  // come from the slot's sealed template entries. An action_name absent from the template
  // resolves to nothing at derive time, so it has to fail here instead.
  const actionNamesBySlot = new Map(
    bp.slots.map((s) => [s.key, new Set(s.sealed_template.entries.map((e) => e.mqtt_action_name))]),
  );
  const checkTarget = (
    where: string,
    slotKey?: string | null,
    actionName?: string | null,
  ): void => {
    if (!slotKey) return;
    const names = actionNamesBySlot.get(slotKey);
    if (!names) {
      problems.push(`${where} addresses slot "${slotKey}", which is not declared`);
      return;
    }
    if (actionName && !names.has(actionName)) {
      const slot = bp.slots.find((s) => s.key === slotKey)!;
      problems.push(
        `${where} addresses action "${actionName}" on slot "${slotKey}", which sealed template "${slot.sealed_template.name}" does not provide` +
          (names.size ? ` (it has: ${[...names].join(', ')})` : ' (it has no entries)'),
      );
    }
  };
  const checkRefs = (where: string, value?: string | null): void => {
    for (const err of validateParamRefs(value, paramKeys, fieldKeys)) {
      problems.push(`${where}: ${err}`);
    }
  };

  // A positional value (F11.14) is checked twice: `positionalError` catches a literal that is not a
  // value of its kind ("60s", "8pm"), and `checkRefs` catches a reference to a key nothing
  // declares. Both failures are silent at run time — the first resolves to null and the second
  // resolves to null — so both have to be caught before publish.
  const checkPositional = (
    where: string,
    value: string | null,
    kind: 'seconds' | 'clock',
  ): void => {
    const problem = positionalError(value, kind);
    if (problem) problems.push(`${where}: ${problem}`);
    checkRefs(where, value);
  };

  // ── Fan-out (F11.2) ───────────────────────────────────────────────────────────────────────
  //
  // Two failures are caught here because neither can be detected at derive time — both produce an
  // automation that simply never does the right thing rather than one that errors:
  //
  //   1. `per_device` over a slot the template never addresses would emit N identical copies.
  //   2. `@phase.` inside a `combined` template over a *profiled* slot cannot resolve at all: the
  //      bound devices disagree about which phase they are in, and one entity has one context. The
  //      per-device block (F11.7) is what a setup-wide automation reads instead.
  //   3. A device selector (F11.9) that can never select anything: no slot to select from, a slot
  //      whose devices have no lifecycle to be selected by, or a lifecycle that is not declared.
  //      Each of those silently produces an automation covering nobody.
  const profiledSlots = new Set(bp.slots.filter((s) => s.profiled).map((s) => s.key));
  const declaredProfiles = new Set(bp.profiles.map((pr) => pr.key));
  const checkFanOut = (
    where: string,
    t: {
      fan_out: string;
      fan_out_slot_key: string | null;
      fan_out_profiles: string[];
      phase_scope: string[];
    },
    addressed: (string | null | undefined)[],
    values: (string | null | undefined)[],
  ): void => {
    const slots = new Set(addressed.filter((s): s is string => !!s));
    if (t.fan_out !== 'combined' && t.fan_out !== 'per_device') {
      problems.push(`${where} has unknown fan_out "${t.fan_out}" (use combined or per_device)`);
      return;
    }

    // The device selector (F11.9) — WHICH of the slot's devices take part, orthogonal to how many
    // entities the mode produces. Checked before the mode because it applies to both: `combined`
    // plus a selector is one automation over some devices, `per_device` plus one is an automation
    // each for some devices.
    if (t.fan_out_profiles.length > 0) {
      const named = t.fan_out_profiles.join(', ');
      const slot = bp.slots.find((s) => s.key === t.fan_out_slot_key);
      if (!t.fan_out_slot_key) {
        problems.push(
          `${where} is limited to lifecycle(s) ${named} but names no slot to select from`,
        );
      } else if (!slot) {
        problems.push(
          `${where} selects devices of slot "${t.fan_out_slot_key}", which is not declared`,
        );
      } else if (!slot.profiled) {
        problems.push(
          `${where} is limited to lifecycle(s) ${named}, but the devices of slot "${slot.key}" do not each follow one — only a slot whose devices have their own lifecycle can be narrowed by lifecycle`,
        );
      } else if (!slots.has(slot.key)) {
        problems.push(
          `${where} selects only some devices of slot "${slot.key}" but never addresses it, so the selection would change nothing`,
        );
      }
      for (const key of t.fan_out_profiles) {
        if (!declaredProfiles.has(key)) {
          problems.push(
            `${where} is limited to lifecycle "${key}", which is not a declared lifecycle` +
              (declaredProfiles.size
                ? ` (has: ${[...declaredProfiles].join(', ')})`
                : ' (this blueprint declares none)'),
          );
        }
      }
    }

    if (t.fan_out === 'per_device') {
      const slot = bp.slots.find((s) => s.key === t.fan_out_slot_key);
      if (!t.fan_out_slot_key) {
        problems.push(`${where} fans out per device but names no slot to fan out over`);
      } else if (!slot) {
        problems.push(`${where} fans out over slot "${t.fan_out_slot_key}", which is not declared`);
      } else if (slot.max_count <= 1) {
        problems.push(
          `${where} fans out over slot "${slot.key}", which holds at most one device — there is nothing to fan out`,
        );
      } else if (!slots.has(slot.key)) {
        problems.push(
          `${where} fans out over slot "${slot.key}" but never addresses it, so every copy would be identical`,
        );
      }
      return;
    }
    // combined
    const profiled = [...slots].filter((s) => profiledSlots.has(s));
    if (profiled.length === 0) return;
    const phaseRefs = values.flatMap((v) => findParamRefs(v)).filter((r) => r.kind === 'phase');
    if (phaseRefs.length > 0) {
      problems.push(
        `${where} is combined over profiled slot "${profiled[0]}" but references ${phaseRefs[0]!.raw} — each bound device is in its own phase, so one entity cannot resolve it (use fan_out: per_device)`,
      );
    }
    if (t.phase_scope.length > 0) {
      problems.push(
        `${where} is combined over profiled slot "${profiled[0]}" but is scoped to phases — the setup has no phase of its own once its bound devices each have one (use fan_out: per_device)`,
      );
    }
  };

  // Phase scope (F10): an automation may declare the phases it is active in. Every key must name a
  // real phase — an unknown key silently makes the automation inert (it can never match the current
  // phase), the same failure class as a threshold referencing an undeclared param.
  // A scope names phase keys; with several lifecycles a key may exist in more than one, and the
  // gate is evaluated against whichever profile the binding follows. So "declared anywhere" is the
  // right test here.
  const phaseKeys = new Set(everyPhase.map((p) => p.key));
  const checkPhaseScope = (where: string, scope: string[]): void => {
    for (const key of scope) {
      if (!phaseKeys.has(key)) {
        problems.push(
          `${where} is scoped to phase "${key}", which is not a declared phase` +
            (phaseKeys.size
              ? ` (has: ${[...phaseKeys].join(', ')})`
              : ' (this blueprint has no phases)'),
        );
      }
    }
  };

  for (const scene of bp.scenes) {
    checkPhaseScope(`scene "${scene.key}"`, scene.phase_scope);
    checkFanOut(
      `scene "${scene.key}"`,
      scene,
      scene.members.map((m) => m.slot_key),
      scene.members.map((m) => m.target_state),
    );
    for (const m of scene.members) {
      checkTarget(`scene "${scene.key}"`, m.slot_key, m.action_name);
      checkRefs(`scene "${scene.key}" target_state`, m.target_state);
      checkPositional(`scene "${scene.key}" delay_seconds`, m.delay_seconds, 'seconds');
      checkPositional(`scene "${scene.key}" duration_seconds`, m.duration_seconds, 'seconds');
    }
  }
  for (const rule of bp.rules) {
    checkPhaseScope(`rule "${rule.key}"`, rule.phase_scope);
    checkFanOut(
      `rule "${rule.key}"`,
      rule,
      [...rule.conditions.map((c) => c.slot_key), ...rule.actions.map((a) => a.slot_key)],
      [
        ...rule.conditions.map((c) => c.threshold_value),
        ...rule.actions.map((a) => a.target_state),
      ],
    );
    if (rule.conditions.length === 0) problems.push(`rule "${rule.key}" has no conditions`);
    if (rule.actions.length === 0) problems.push(`rule "${rule.key}" has no actions`);
    for (const c of rule.conditions) {
      checkTarget(`rule "${rule.key}" condition`, c.slot_key, c.action_name);
      checkRefs(`rule "${rule.key}" threshold_value`, c.threshold_value);
      checkPositional(`rule "${rule.key}" schedule_time`, c.schedule_time, 'clock');
      checkPositional(`rule "${rule.key}" schedule_until`, c.schedule_until, 'clock');
      // A device_status condition resolves its slot to the bound DEVICES, so it needs a slot to
      // resolve and a state to compare. Without either it evaluates false forever — the same
      // silent-inertness class as an undeclared reference, so it is refused at publish.
      if (c.condition_type === 'device_status' || c.condition_type === 'device_state') {
        if (!c.slot_key) {
          problems.push(`rule "${rule.key}" checks a device's status but names no slot`);
        }
        if (c.status_value !== 'online' && c.status_value !== 'offline') {
          problems.push(
            `rule "${rule.key}" checks a device's status but its status_value is "${c.status_value ?? ''}" (use online or offline)`,
          );
        }
      }
      // A schedule that does not parse fires never, and "never" is indistinguishable from a rule
      // whose conditions simply have not been met — so it has to be caught before publish.
      if (c.condition_type === 'schedule') {
        const problem = validateSchedule(scheduleOf(c));
        if (problem) problems.push(`rule "${rule.key}" schedule: ${problem}`);
      }
    }
    for (const a of rule.actions) {
      checkTarget(`rule "${rule.key}" action`, a.slot_key, a.action_name);
      checkRefs(`rule "${rule.key}" target_state`, a.target_state);
      checkPositional(`rule "${rule.key}" delay_seconds`, a.delay_seconds, 'seconds');
      checkPositional(`rule "${rule.key}" duration_seconds`, a.duration_seconds, 'seconds');
    }
  }
  for (const pipeline of bp.pipelines) {
    checkPhaseScope(`pipeline "${pipeline.key}"`, pipeline.phase_scope);
    checkFanOut(
      `pipeline "${pipeline.key}"`,
      pipeline,
      [...pipeline.sensors.map((s) => s.slot_key), ...pipeline.triggers.map((t) => t.slot_key)],
      [
        ...pipeline.sensors.flatMap((s) => [s.min_value, s.max_value]),
        ...pipeline.triggers.map((t) => t.threshold_value),
        ...pipeline.stages.map((s) => s.prompt_template),
      ],
    );
    const stageOrdinals = new Set<number>();
    for (const s of pipeline.stages) {
      if (stageOrdinals.has(s.ordinal)) {
        problems.push(`pipeline "${pipeline.key}" has duplicate stage ordinal ${s.ordinal}`);
      }
      stageOrdinals.add(s.ordinal);
      if (s.kind === 'infer' && !s.has_model) {
        problems.push(`pipeline "${pipeline.key}" infer stage ${s.ordinal} has no model`);
      }
      // prompt_template is free text, so references live inside a sentence rather than being
      // the whole value — findParamRefs (not isParamRef) is the right check.
      checkRefs(`pipeline "${pipeline.key}" prompt_template`, s.prompt_template);
    }
    for (const sensor of pipeline.sensors) {
      checkTarget(`pipeline "${pipeline.key}" sensor`, sensor.slot_key, sensor.action_name);
      checkRefs(`pipeline "${pipeline.key}" min_value`, sensor.min_value);
      checkRefs(`pipeline "${pipeline.key}" max_value`, sensor.max_value);
    }
    for (const t of pipeline.triggers) {
      checkTarget(`pipeline "${pipeline.key}" trigger`, t.slot_key, t.action_name);
      checkRefs(`pipeline "${pipeline.key}" trigger threshold`, t.threshold_value);
      checkPositional(`pipeline "${pipeline.key}" schedule_time`, t.schedule_time, 'clock');
      checkPositional(`pipeline "${pipeline.key}" schedule_until`, t.schedule_until, 'clock');
      if (t.trigger_type === 'schedule') {
        const problem = validateSchedule(scheduleOf(t));
        if (problem) problems.push(`pipeline "${pipeline.key}" schedule: ${problem}`);
      }
    }
  }

  return problems;
}

/** Validate what is stored — the publish gate. */
export async function collectProblems(blueprintId: number): Promise<string[]> {
  const bp = await db.blueprint.findUnique({
    where: { id: blueprintId },
    include: blueprintInclude,
  });
  if (!bp) throw notFound();

  return problemsFor({
    is_static: bp.is_static,
    slots: bp.slots.map((s) => ({
      key: s.key,
      min_count: s.min_count,
      max_count: s.max_count,
      profiled: s.profiled,
      sealed_template: {
        name: s.sealed_template.name,
        status: s.sealed_template.status,
        entries: s.sealed_template.entries.map((e) => ({ mqtt_action_name: e.mqtt_action_name })),
      },
    })),
    params: bp.params.map((p) => ({ key: p.key, default_value: p.default_value })),
    fields: bp.fields.map((f) => ({
      key: f.key,
      input_type: f.input_type,
      scope: f.scope,
      slot_key: f.slot_key,
      required: f.required,
      default_value: f.default_value,
      options: f.options.map((o) => ({ value: o.value, profile_key: o.profile_key })),
    })),
    profiles: bp.profiles.map((pr) => ({
      key: pr.key,
      phases: pr.phases.map((p) => ({
        key: p.key,
        ordinal: p.ordinal,
        advance_mode: p.advance_mode,
        advance_ref_key: p.advance_ref_key,
        advance_to_key: p.advance_to_key,
        duration_value: p.duration_value,
        context_notes: p.context_notes,
        targets: p.targets.map((t) => ({ param_key: t.param_key })),
      })),
    })),
    scenes: bp.scenes.map((s) => ({
      key: s.key,
      phase_scope: s.phase_scope,
      fan_out: s.fan_out,
      fan_out_slot_key: s.fan_out_slot_key,
      fan_out_profiles: s.fan_out_profiles,
      members: s.members,
    })),
    rules: bp.rules.map((r) => ({
      key: r.key,
      phase_scope: r.phase_scope,
      fan_out: r.fan_out,
      fan_out_slot_key: r.fan_out_slot_key,
      fan_out_profiles: r.fan_out_profiles,
      conditions: r.conditions,
      actions: r.actions,
    })),
    pipelines: bp.pipelines.map((p) => ({
      key: p.key,
      phase_scope: p.phase_scope,
      fan_out: p.fan_out,
      fan_out_slot_key: p.fan_out_slot_key,
      fan_out_profiles: p.fan_out_profiles,
      stages: p.stages.map((s) => ({
        ordinal: s.ordinal,
        kind: s.kind,
        has_model: s.ml_model_id !== null,
        prompt_template: s.prompt_template,
      })),
      sensors: p.sensors,
      triggers: p.triggers,
    })),
  });
}

/**
 * Validate a document that has not been saved — what the builder's Validate button runs.
 *
 * The document references sealed templates by name (so it can move between databases), so the
 * only DB work is resolving those names; everything else is already in hand. An unknown name is
 * reported rather than thrown, so the admin sees it beside the other problems.
 */
export async function collectDocumentProblems(doc: BlueprintDoc): Promise<string[]> {
  const names = [...new Set(doc.slots.map((s) => s.sealed_template).filter(Boolean))];
  const templates = await db.sealedTemplate.findMany({
    where: { name: { in: names } },
    select: {
      name: true,
      status: true,
      entries: { select: { mqtt_action_name: true } },
    },
  });
  const byName = new Map(templates.map((t) => [t.name, t]));

  const problems: string[] = [];
  for (const name of names) {
    if (!byName.has(name)) problems.push(`sealed template "${name}" does not exist`);
  }

  problems.push(
    ...problemsFor({
      is_static: doc.is_static ?? false,
      // A slot whose template is unknown is reported above; give it an empty stand-in so the rest
      // of the document still gets checked instead of the first bad name masking everything.
      slots: doc.slots.map((s) => ({
        key: s.key,
        min_count: s.min_count ?? 1,
        max_count: s.max_count ?? 1,
        profiled: s.profiled ?? false,
        sealed_template: byName.get(s.sealed_template) ?? {
          name: s.sealed_template,
          status: 'released',
          entries: [],
        },
      })),
      params: (doc.params ?? []).map((p) => ({ key: p.key, default_value: p.default_value ?? '' })),
      fields: (doc.fields ?? []).map((f) => ({
        key: f.key,
        input_type: f.input_type ?? 'text',
        scope: f.scope ?? 'setup',
        slot_key: f.slot_key ?? null,
        required: f.required ?? false,
        default_value: f.default_value ?? null,
        options: (f.options ?? []).map((o) => ({
          value: o.value,
          profile_key: o.profile_key ?? null,
        })),
      })),
      // profileDocs normalises the single-lifecycle `phases` shorthand into one implicit profile,
      // so validating an unsaved document sees exactly the shape a saved one has.
      profiles: profileDocs(doc).map((pr) => ({
        key: pr.key,
        phases: pr.phases.map((p) => ({
          key: p.key,
          ordinal: p.ordinal,
          advance_mode: p.advance_mode ?? 'manual',
          advance_ref_key: p.advance_ref_key ?? null,
          advance_to_key: p.advance_to_key ?? null,
          duration_value:
            p.duration_value === null || p.duration_value === undefined || p.duration_value === ''
              ? null
              : String(p.duration_value),
          context_notes: p.context_notes ?? null,
          targets: p.targets ?? [],
        })),
      })),
      scenes: (doc.scenes ?? []).map((s) => ({
        key: s.key,
        phase_scope: s.phase_scope ?? [],
        ...docFanOut(s),
        members: (s.members ?? []).map((m) => ({
          slot_key: m.slot_key,
          action_name: m.action_name,
          target_state: m.target_state,
          delay_seconds: positionalText(m.delay_seconds),
          duration_seconds: positionalText(m.duration_seconds),
        })),
      })),
      rules: (doc.rules ?? []).map((r) => ({
        key: r.key,
        phase_scope: r.phase_scope ?? [],
        ...docFanOut(r),
        conditions: (r.conditions ?? []).map((c) => ({
          condition_type: c.condition_type,
          slot_key: c.slot_key ?? null,
          action_name: c.action_name ?? null,
          status_value: c.status_value ?? null,
          threshold_value: c.threshold_value ?? null,
          schedule_time: c.schedule_time ?? null,
          schedule_until: c.schedule_until ?? null,
          schedule_every_minutes: c.schedule_every_minutes ?? null,
          schedule_days: c.schedule_days ?? [],
        })),
        actions: (r.actions ?? []).map((a) => ({
          slot_key: a.slot_key,
          action_name: a.action_name,
          target_state: a.target_state,
          delay_seconds: positionalText(a.delay_seconds),
          duration_seconds: positionalText(a.duration_seconds),
        })),
      })),
      pipelines: (doc.pipelines ?? []).map((p) => ({
        key: p.key,
        phase_scope: p.phase_scope ?? [],
        ...docFanOut(p),
        stages: (p.stages ?? []).map((s) => ({
          ordinal: s.ordinal,
          kind: s.kind,
          has_model: !!s.ml_model,
          prompt_template: s.prompt_template ?? null,
        })),
        sensors: (p.sensors ?? []).map((s) => ({
          slot_key: s.slot_key,
          action_name: s.action_name,
          min_value: s.min_value ?? null,
          max_value: s.max_value ?? null,
        })),
        triggers: (p.triggers ?? []).map((t) => ({
          trigger_type: t.trigger_type,
          slot_key: t.slot_key ?? null,
          action_name: t.action_name ?? null,
          threshold_value: t.threshold_value ?? null,
          schedule_time: t.schedule_time ?? null,
          schedule_until: t.schedule_until ?? null,
          schedule_every_minutes: t.schedule_every_minutes ?? null,
          schedule_days: t.schedule_days ?? [],
        })),
      })),
    }),
  );
  return problems;
}
