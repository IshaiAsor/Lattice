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

export type ParamRefKind = 'param' | 'phase';

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
  /** `blueprint_param_overrides` — the user's own tuning. Beats everything. */
  overrides: Record<string, string>;
  /** `blueprint_phase_targets` for the instance's current phase. */
  phaseTargets: Record<string, string>;
  /** `blueprint_params.default_value`. */
  defaults: Record<string, string>;
  /** Null when the instance has no current phase (a blueprint without phases, say). */
  phase?: PhaseMeta | null;
}

/**
 * Phase metadata, not params. `@phase.name` addresses the phase itself, so a blueprint may not
 * declare a param under one of these keys — the ref would be ambiguous.
 */
export const RESERVED_PHASE_KEYS = ['key', 'name', 'context_notes'] as const;

// Dots separate key segments (`humidity.min`) but may not trail, so `"…@phase.name."` at the end
// of a prompt sentence yields the key `name` and leaves the full stop as prose.
const REF_SOURCE = '@(param|phase)\\.([a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)*)';
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

function resolveRef(ref: ParamRef, ctx: ParamContext): string | null {
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

  const override = ctx.overrides[ref.key];
  if (override !== undefined) return override;

  // `@param.` deliberately skips the phase: it addresses the blueprint's own value, for the
  // settings a phase is not allowed to retune.
  if (ref.kind === 'phase') {
    const target = ctx.phaseTargets[ref.key];
    if (target !== undefined) return target;
  }

  return ctx.defaults[ref.key] ?? null;
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
): string[] {
  const declared = new Set(declaredKeys);
  const errors: string[] = [];
  for (const ref of findParamRefs(value)) {
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
