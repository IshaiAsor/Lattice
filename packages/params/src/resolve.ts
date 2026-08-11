// Blueprint parameter references (F10). Derived automations store *references* rather than
// values, so that the three actors who want to change the same rule — reconcile, phase advance,
// and the user — write to disjoint places and cannot clobber each other
// (docs/plans/blueprints-redesign.md §3).
//
// This is the single implementation of the grammar, shared by automation-worker (rule
// evaluation), api (write-time validation) and ml-router (pipeline enrich + prompt build).
// Three private copies would eventually disagree, and a disagreement here silently changes
// what a rule fires on.
//
// Pure — no I/O. The caller loads the context once per entity and passes it in, so resolution
// itself is synchronous and unit-testable without a database.

export type ParamRefKind = 'param' | 'phase' | 'field';

export interface ParamRef {
  kind: ParamRefKind;
  key: string;
  /** The exact source text, e.g. `@phase.humidity.min` — used for logging and replacement. */
  raw: string;
}

/** The current phase's own metadata, addressable as `@phase.name` / `@phase.context_notes`. */
export interface PhaseMeta {
  key: string;
  name: string;
  context_notes?: string | null;
}

/**
 * Everything resolution needs, loaded once per entity from its `blueprint_instance_id`.
 * An entity with no instance never builds one — every non-blueprint rule on the platform
 * keeps costing exactly what it costs today.
 */
export interface ParamContext {
  /**
   * `blueprint_binding_param_overrides` scoped to this binding's *current* phase (F11.3). Present
   * only on a context built for one binding; the most specific layer there is — "this one device,
   * in this phase, wants a different number".
   */
  bindingPhaseOverrides?: Record<string, string>;
  /** `blueprint_binding_param_overrides` the user set on this binding for every phase. */
  bindingOverrides?: Record<string, string>;
  /**
   * `blueprint_param_overrides` rows scoped to the instance's *current* phase. The most specific
   * layer there is: "in this phase, for this setup, use this".
   */
  phaseOverrides: Record<string, string>;
  /** `blueprint_param_overrides` rows the user set for every phase. */
  overrides: Record<string, string>;
  /** `blueprint_phase_targets` for the instance's current phase. */
  phaseTargets: Record<string, string>;
  /** `blueprint_params.default_value`. */
  defaults: Record<string, string>;
  /** Null when the instance has no current phase (a blueprint without phases, say). */
  phase?: PhaseMeta | null;
  /**
   * The setup's lifecycle (F10.13), carried here so the callers that already load a context for
   * resolution get the run/hold gate from the same read. Null/absent means "not from a blueprint
   * instance", which is always live.
   */
  lifecycle?: string | null;
  /**
   * The binding's own lifecycle (F11.3), on a context built for one binding. Null/absent means the
   * automation is not per-binding, so only the setup's gate applies.
   */
  bindingLifecycle?: string | null;
  /**
   * What the user answered to this blueprint's declared fields (F11.6), already collapsed in
   * precedence order — this binding's answer, else the setup's, else the field's default. Facts, not
   * tunable values: no phase retunes them, which is why they are one map rather than layers.
   */
  fields?: Record<string, string>;
}

/**
 * Phase metadata, not params. `@phase.name` addresses the phase itself, so a blueprint may not
 * declare a param under one of these keys — the ref would be ambiguous.
 */
export const RESERVED_PHASE_KEYS = ['key', 'name', 'context_notes'] as const;

// Dots separate key segments (`humidity.min`) but may not trail, so `"…@phase.name."` at the end
// of a prompt sentence yields the key `name` and leaves the full stop as prose.
const REF_SOURCE = '@(param|phase|field)\\.([a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)*)';
const WHOLE_REF = new RegExp(`^${REF_SOURCE}$`);
const ANY_REF = new RegExp(REF_SOURCE, 'g');

/** True when the entire value is a reference — the shape stored in `threshold_value` etc. */
export function isParamRef(value: string | null | undefined): boolean {
  return typeof value === 'string' && WHOLE_REF.test(value.trim());
}

export function parseParamRef(value: string | null | undefined): ParamRef | null {
  if (typeof value !== 'string') return null;
  const m = WHOLE_REF.exec(value.trim());
  if (!m) return null;
  return { kind: m[1] as ParamRefKind, key: m[2], raw: m[0] };
}

/** Every reference embedded anywhere in free text — prompt templates, mostly. */
export function findParamRefs(text: string | null | undefined): ParamRef[] {
  if (typeof text !== 'string') return [];
  const refs: ParamRef[] = [];
  for (const m of text.matchAll(ANY_REF)) {
    refs.push({ kind: m[1] as ParamRefKind, key: m[2], raw: m[0] });
  }
  return refs;
}

/** Which layer supplied a resolved value. */
export type ParamSource =
  | 'binding_phase_override'
  | 'binding_override'
  | 'phase_override'
  | 'override'
  | 'phase'
  | 'default';

export interface ResolvedWithSource {
  value: string | null;
  source: ParamSource;
}

/**
 * The precedence, written once as data. Everything that needs to know the order — resolution and
 * the instance page's "where did this come from" label — walks this same array, so the page cannot
 * attribute a value to a layer the resolver didn't actually use.
 *
 * `phaseScoped` layers are skipped for `@param.`, which addresses the blueprint's own value for the
 * settings a phase is not allowed to retune: neither the phase's target nor a phase-scoped
 * override may leak into it.
 *
 * The two binding layers sit on top (F11.3): one device's tuning is more specific than the whole
 * setup's, and both are more specific than the profile's schedule. On a context that describes no
 * binding they are simply absent, so a setup whose slots are unprofiled resolves through exactly
 * the four layers it always did.
 */
const PARAM_LAYERS = [
  {
    source: 'binding_phase_override',
    phaseScoped: true,
    pick: (c: ParamContext) => c.bindingPhaseOverrides,
  },
  { source: 'binding_override', phaseScoped: false, pick: (c: ParamContext) => c.bindingOverrides },
  { source: 'phase_override', phaseScoped: true, pick: (c: ParamContext) => c.phaseOverrides },
  { source: 'override', phaseScoped: false, pick: (c: ParamContext) => c.overrides },
  { source: 'phase', phaseScoped: true, pick: (c: ParamContext) => c.phaseTargets },
  { source: 'default', phaseScoped: false, pick: (c: ParamContext) => c.defaults },
] as const satisfies readonly {
  source: ParamSource;
  phaseScoped: boolean;
  pick: (c: ParamContext) => Record<string, string> | undefined;
}[];

function walkLayers(
  key: string,
  ctx: ParamContext,
  includePhaseScoped: boolean,
): ResolvedWithSource {
  for (const layer of PARAM_LAYERS) {
    if (layer.phaseScoped && !includePhaseScoped) continue;
    // `?? {}` because resolution runs inside the rule-evaluation loop: a context assembled by hand
    // (or by a service built against an older shape) must degrade to "that layer is empty", never
    // throw. Failing closed is the contract here — a throw would take down the whole pass.
    const value = (layer.pick(ctx) ?? {})[key];
    if (value !== undefined) return { value, source: layer.source };
  }
  return { value: null, source: 'default' };
}

/**
 * Resolve a declared param key and report the layer that supplied it, with `@phase.` precedence.
 * The instance page uses this so its "your value" / "from this phase" labels are the resolver's
 * own answer rather than a second implementation of the same order.
 */
export function resolveParamWithSource(key: string, ctx: ParamContext): ResolvedWithSource {
  return walkLayers(key, ctx, true);
}

function resolveRef(ref: ParamRef, ctx: ParamContext): string | null {
  // A field is a stated fact, not a tuned value — it does not walk the param layers at all. An
  // unanswered field resolves to null (fail closed), exactly like an undeclared param.
  if (ref.kind === 'field') return ctx.fields?.[ref.key] ?? null;

  if (ref.kind === 'phase') {
    // Phase metadata is addressed directly and is not overridable — it describes the phase,
    // it isn't a value the user tunes.
    switch (ref.key) {
      case 'key':
        return ctx.phase?.key ?? null;
      case 'name':
        return ctx.phase?.name ?? null;
      // Notes are optional by design; an instance with none should drop the reference from the
      // prompt rather than leave `@phase.context_notes` sitting in the text sent to the model.
      case 'context_notes':
        return ctx.phase ? (ctx.phase.context_notes ?? '') : null;
    }
  }

  return walkLayers(ref.key, ctx, ref.kind === 'phase').value;
}

/**
 * Resolve a whole-value field (`threshold_value`, `target_state`, `min_value`/`max_value`).
 *
 * A literal resolves to itself, so every rule written before blueprints existed passes through
 * untouched. An unresolvable reference returns **null** rather than the raw text — the caller
 * must treat that as "condition false, log a warning" so a broken reference fails closed
 * instead of comparing against `NaN` and silently never firing.
 */
export function resolveParam(value: string | null | undefined, ctx: ParamContext): string | null {
  if (typeof value !== 'string') return null;
  const ref = parseParamRef(value);
  if (!ref) return value;
  return resolveRef(ref, ctx);
}

export interface ResolvedText {
  text: string;
  /** Raw references that had no value; the caller logs these. */
  unresolved: string[];
}

/**
 * Substitute every reference embedded in free text — the prompt-template case, where the
 * reference is one word inside a sentence rather than the whole field.
 *
 * Unresolvable references are removed from the output (and reported), never left verbatim:
 * a prompt reading "the setup is in its @phase.name phase" would otherwise be sent to the model
 * exactly like that.
 */
export function resolveText(text: string | null | undefined, ctx: ParamContext): ResolvedText {
  if (typeof text !== 'string') return { text: '', unresolved: [] };
  const unresolved: string[] = [];
  const out = text.replace(ANY_REF, (raw, kind: string, key: string) => {
    const resolved = resolveRef({ kind: kind as ParamRefKind, key, raw }, ctx);
    if (resolved === null) {
      unresolved.push(raw);
      return '';
    }
    return resolved;
  });
  return { text: out, unresolved };
}

/**
 * Write-time validation (§3: "validated on write, resolved on read"). Returns one message per
 * problem, empty when the value is clean.
 *
 * `declaredKeys` is the blueprint's `BlueprintParam.key` set. Catching a typo here is the whole
 * point — at evaluation time an undeclared reference is indistinguishable from a deleted param,
 * and both just make the rule stop firing.
 */
export function validateParamRefs(
  value: string | null | undefined,
  declaredKeys: Iterable<string>,
  declaredFieldKeys: Iterable<string> = [],
): string[] {
  const declared = new Set(declaredKeys);
  const fields = new Set(declaredFieldKeys);
  const errors: string[] = [];
  for (const ref of findParamRefs(value)) {
    if (ref.kind === 'field') {
      // Same reasoning one table over: at derive time an undeclared `@field.x` is
      // indistinguishable from a field the author renamed, and both just resolve to nothing.
      if (!fields.has(ref.key)) {
        errors.push(`${ref.raw} references an undeclared field "${ref.key}"`);
      }
      continue;
    }
    if (ref.kind === 'phase' && (RESERVED_PHASE_KEYS as readonly string[]).includes(ref.key)) {
      continue;
    }
    if (!declared.has(ref.key)) {
      errors.push(`${ref.raw} references an undeclared parameter "${ref.key}"`);
    }
  }
  return errors;
}

/**
 * A blueprint may not declare a param whose key collides with phase metadata — `@phase.name`
 * has to mean one thing. Used by publish validation.
 */
export function validateParamKey(key: string): string | null {
  if ((RESERVED_PHASE_KEYS as readonly string[]).includes(key)) {
    return `"${key}" is reserved for phase metadata and cannot be a parameter key`;
  }
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(key)) {
    return `"${key}" is not a valid parameter key (letters, digits, underscore, dot-separated)`;
  }
  return null;
}
