import type { ParamContext } from './resolve';

// Assembling a ParamContext from a blueprint instance is the same three-layer shaping in every
// consumer — automation-worker (rule evaluation), api (the instance page) and ml-router (pipeline
// enrich + prompt build). The *query* differs per service, but the shaping must not: if one of
// them assembled the layers differently, the instance page would show a value the rules never act
// on, which is the exact class of silent disagreement this package exists to prevent.
//
// Still pure — the caller does the I/O and hands the rows in.

/** The rows a blueprint instance contributes, in a database-neutral shape. */
export interface ParamContextSource {
  /**
   * `blueprint_param_overrides` for the instance — *all* of them, both scopes. Splitting them by
   * phase is this function's job precisely so no caller has to decide what "" means.
   */
  overrides: { param_key: string; phase_key: string; value: string }[];
  /** `blueprint_params` of its blueprint. */
  defaults: { key: string; default_value: string }[];
  /** The instance's current phase with its targets, or null when it has none. */
  currentPhase: {
    key: string;
    name: string;
    context_notes?: string | null;
    targets: { param_key: string; value: string }[];
  } | null;
  /**
   * `blueprint_instances.lifecycle_state` (F10.13). Carried through so a caller that loaded a
   * context for resolution also holds the run/hold gate — the two questions are answered from one
   * read of the same row, which is what stops them drifting apart.
   */
  lifecycle?: string | null;
  /**
   * The binding this context describes (F11.3), when it describes one. A per-binding automation
   * resolves against that binding's own overrides and its own place in its own profile's lifecycle —
   * so the binding, not the instance, supplies `currentPhase` in that case.
   */
  binding?: {
    /** `blueprint_binding_param_overrides` for this binding — both scopes, split here as above. */
    overrides: { param_key: string; phase_key: string; value: string }[];
    /** `blueprint_slot_bindings.lifecycle_state`. */
    lifecycle?: string | null;
  } | null;
  /**
   * Answers to the blueprint's declared fields (F11.6), most specific first. `binding` is what the
   * user said about this binding, `instance` what they said about the setup, `defaults` what the field
   * declares. Collapsed here so read-time resolution is one map lookup.
   */
  fields?: {
    binding?: { field_key: string; value: string }[];
    instance?: { field_key: string; value: string }[];
    defaults?: { key: string; default_value: string | null }[];
  } | null;
}

/** `phase_key` on an override row: the empty string means "in every phase". */
export const ALL_PHASES = '';

/** Split an override list into (this phase, every phase), the shape both levels need. */
function splitOverrides(
  rows: { param_key: string; phase_key: string; value: string }[],
  currentKey: string | null,
): { phaseScoped: Record<string, string>; allPhases: Record<string, string> } {
  return {
    // A row scoped to a phase the setup is not in contributes nothing to *this* context. It stays
    // in the table — the user set it for later, and advancing is what brings it into effect.
    phaseScoped: Object.fromEntries(
      rows
        .filter((o) => o.phase_key !== ALL_PHASES && o.phase_key === currentKey)
        .map((o) => [o.param_key, o.value]),
    ),
    allPhases: Object.fromEntries(
      rows.filter((o) => o.phase_key === ALL_PHASES).map((o) => [o.param_key, o.value]),
    ),
  };
}

export function buildParamContext(src: ParamContextSource): ParamContext {
  const currentKey = src.currentPhase?.key ?? null;
  const instance = splitOverrides(src.overrides, currentKey);
  const binding = src.binding ? splitOverrides(src.binding.overrides, currentKey) : null;

  // Fields collapse to one map: this binding's answer, else the setup's, else the field's default. A
  // field with no answer anywhere is absent, so `@field.x` resolves to null rather than "".
  const fields: Record<string, string> = {};
  for (const d of src.fields?.defaults ?? []) {
    if (d.default_value != null && d.default_value !== '') fields[d.key] = d.default_value;
  }
  for (const v of src.fields?.instance ?? []) fields[v.field_key] = v.value;
  for (const v of src.fields?.binding ?? []) fields[v.field_key] = v.value;

  return {
    ...(binding
      ? { bindingPhaseOverrides: binding.phaseScoped, bindingOverrides: binding.allPhases }
      : {}),
    phaseOverrides: instance.phaseScoped,
    overrides: instance.allPhases,
    phaseTargets: Object.fromEntries(
      (src.currentPhase?.targets ?? []).map((t) => [t.param_key, t.value]),
    ),
    defaults: Object.fromEntries(src.defaults.map((p) => [p.key, p.default_value])),
    phase: src.currentPhase
      ? {
          key: src.currentPhase.key,
          name: src.currentPhase.name,
          context_notes: src.currentPhase.context_notes ?? null,
        }
      : null,
    lifecycle: src.lifecycle ?? null,
    bindingLifecycle: src.binding ? (src.binding.lifecycle ?? null) : null,
    fields,
  };
}

/**
 * The context for an entity that belongs to no blueprint instance. Every literal passes through
 * untouched and any reference resolves to null (fail closed) — so a hand-written rule costs
 * exactly what it always did, and a reference that somehow reaches one cannot silently succeed.
 */
export const EMPTY_PARAM_CONTEXT: ParamContext = Object.freeze({
  phaseOverrides: {},
  overrides: {},
  phaseTargets: {},
  defaults: {},
  phase: null,
  // Not from a setup, so no setup can hold it: a hand-written rule is unaffected by F10.13.
  lifecycle: null,
  bindingLifecycle: null,
  fields: {},
});
