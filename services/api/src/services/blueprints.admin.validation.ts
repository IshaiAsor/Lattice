import { db } from '../db';
import { validateParamKey, validateParamRefs, findParamRefs } from '@lattice/params';
import { blueprintInclude, notFound, type BlueprintDoc } from './blueprints.admin.types';

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
  slots: {
    key: string;
    min_count: number;
    max_count: number;
    sealed_template: { name: string; status: string; entries: { mqtt_action_name: string }[] };
  }[];
  params: { key: string; default_value: string }[];
  phases: {
    key: string;
    ordinal: number;
    auto_advance: boolean;
    duration_value: number | null;
    context_notes: string | null;
    targets: { param_key: string }[];
  }[];
  scenes: {
    key: string;
    phase_scope: string[];
    members: { slot_key: string; action_name: string; target_state: string }[];
  }[];
  rules: {
    key: string;
    phase_scope: string[];
    conditions: {
      slot_key: string | null;
      action_name: string | null;
      threshold_value: string | null;
    }[];
    actions: { slot_key: string; action_name: string; target_state: string }[];
  }[];
  pipelines: {
    key: string;
    phase_scope: string[];
    stages: { ordinal: number; kind: string; has_model: boolean; prompt_template: string | null }[];
    sensors: {
      slot_key: string;
      action_name: string;
      min_value: string | null;
      max_value: string | null;
    }[];
    triggers: {
      slot_key: string | null;
      action_name: string | null;
      threshold_value: string | null;
    }[];
  }[];
}

// Every value position that may hold an `@param.` / `@phase.` reference, so validation and the
// eventual derive agree on where references are legal.
function problemsFor(bp: ValidationShape): string[] {
  const problems: string[] = [];
  const paramKeys = new Set(bp.params.map((p) => p.key));

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

  const phaseSetKeys = new Set(bp.phases.flatMap((p) => p.targets.map((t) => t.param_key)));
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

  const ordinals = new Set<number>();
  for (const phase of bp.phases) {
    if (ordinals.has(phase.ordinal)) problems.push(`duplicate phase ordinal ${phase.ordinal}`);
    ordinals.add(phase.ordinal);
    if (phase.auto_advance && !phase.duration_value) {
      problems.push(`phase "${phase.key}" auto-advances but has no duration`);
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
    for (const err of validateParamRefs(value, paramKeys)) problems.push(`${where}: ${err}`);
  };

  // Phase scope (F10): an automation may declare the phases it is active in. Every key must name a
  // real phase — an unknown key silently makes the automation inert (it can never match the current
  // phase), the same failure class as a threshold referencing an undeclared param.
  const phaseKeys = new Set(bp.phases.map((p) => p.key));
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
    for (const m of scene.members) {
      checkTarget(`scene "${scene.key}"`, m.slot_key, m.action_name);
      checkRefs(`scene "${scene.key}" target_state`, m.target_state);
    }
  }
  for (const rule of bp.rules) {
    checkPhaseScope(`rule "${rule.key}"`, rule.phase_scope);
    if (rule.conditions.length === 0) problems.push(`rule "${rule.key}" has no conditions`);
    if (rule.actions.length === 0) problems.push(`rule "${rule.key}" has no actions`);
    for (const c of rule.conditions) {
      checkTarget(`rule "${rule.key}" condition`, c.slot_key, c.action_name);
      checkRefs(`rule "${rule.key}" threshold_value`, c.threshold_value);
    }
    for (const a of rule.actions) {
      checkTarget(`rule "${rule.key}" action`, a.slot_key, a.action_name);
      checkRefs(`rule "${rule.key}" target_state`, a.target_state);
    }
  }
  for (const pipeline of bp.pipelines) {
    checkPhaseScope(`pipeline "${pipeline.key}"`, pipeline.phase_scope);
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
    slots: bp.slots.map((s) => ({
      key: s.key,
      min_count: s.min_count,
      max_count: s.max_count,
      sealed_template: {
        name: s.sealed_template.name,
        status: s.sealed_template.status,
        entries: s.sealed_template.entries.map((e) => ({ mqtt_action_name: e.mqtt_action_name })),
      },
    })),
    params: bp.params.map((p) => ({ key: p.key, default_value: p.default_value })),
    phases: bp.phases.map((p) => ({
      key: p.key,
      ordinal: p.ordinal,
      auto_advance: p.auto_advance,
      duration_value: p.duration_value,
      context_notes: p.context_notes,
      targets: p.targets.map((t) => ({ param_key: t.param_key })),
    })),
    scenes: bp.scenes.map((s) => ({ key: s.key, phase_scope: s.phase_scope, members: s.members })),
    rules: bp.rules.map((r) => ({
      key: r.key,
      phase_scope: r.phase_scope,
      conditions: r.conditions,
      actions: r.actions,
    })),
    pipelines: bp.pipelines.map((p) => ({
      key: p.key,
      phase_scope: p.phase_scope,
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
      // A slot whose template is unknown is reported above; give it an empty stand-in so the rest
      // of the document still gets checked instead of the first bad name masking everything.
      slots: doc.slots.map((s) => ({
        key: s.key,
        min_count: s.min_count ?? 1,
        max_count: s.max_count ?? 1,
        sealed_template: byName.get(s.sealed_template) ?? {
          name: s.sealed_template,
          status: 'released',
          entries: [],
        },
      })),
      params: (doc.params ?? []).map((p) => ({ key: p.key, default_value: p.default_value ?? '' })),
      phases: (doc.phases ?? []).map((p) => ({
        key: p.key,
        ordinal: p.ordinal,
        auto_advance: p.auto_advance ?? false,
        duration_value: p.duration_value ?? null,
        context_notes: p.context_notes ?? null,
        targets: p.targets ?? [],
      })),
      scenes: (doc.scenes ?? []).map((s) => ({
        key: s.key,
        phase_scope: s.phase_scope ?? [],
        members: s.members ?? [],
      })),
      rules: (doc.rules ?? []).map((r) => ({
        key: r.key,
        phase_scope: r.phase_scope ?? [],
        conditions: (r.conditions ?? []).map((c) => ({
          slot_key: c.slot_key ?? null,
          action_name: c.action_name ?? null,
          threshold_value: c.threshold_value ?? null,
        })),
        actions: r.actions ?? [],
      })),
      pipelines: (doc.pipelines ?? []).map((p) => ({
        key: p.key,
        phase_scope: p.phase_scope ?? [],
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
          slot_key: t.slot_key ?? null,
          action_name: t.action_name ?? null,
          threshold_value: t.threshold_value ?? null,
        })),
      })),
    }),
  );
  return problems;
}
