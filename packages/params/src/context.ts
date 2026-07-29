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
  /** `blueprint_param_overrides` for the instance. */
  overrides: { param_key: string; value: string }[];
  /** `blueprint_params` of its blueprint. */
  defaults: { key: string; default_value: string }[];
  /** The instance's current phase with its targets, or null when it has none. */
  currentPhase: {
    key: string;
    name: string;
    context_notes?: string | null;
    targets: { param_key: string; value: string }[];
  } | null;
}

export function buildParamContext(src: ParamContextSource): ParamContext {
  return {
    overrides: Object.fromEntries(src.overrides.map((o) => [o.param_key, o.value])),
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
  };
}

/**
 * The context for an entity that belongs to no blueprint instance. Every literal passes through
 * untouched and any reference resolves to null (fail closed) — so a hand-written rule costs
 * exactly what it always did, and a reference that somehow reaches one cannot silently succeed.
 */
export const EMPTY_PARAM_CONTEXT: ParamContext = Object.freeze({
  overrides: {},
  phaseTargets: {},
  defaults: {},
  phase: null,
});
