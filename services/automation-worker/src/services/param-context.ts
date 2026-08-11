import { buildParamContext, type ParamContext } from '@lattice/params';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';

const log = createLogger('automation-worker:params');

// Loads the resolution context for a blueprint instance (F10.1b): what `@param.x` / `@phase.x` /
// `@field.x` mean *right now* for one derived setup. The precedence and shaping live in
// @lattice/params — this only supplies the rows.
//
// Since F11.2 an automation may belong to one *binding* rather than the whole setup, and then the
// context is that binding's: its own overrides, its own answers, and — crucially — its own place in
// its own profile's lifecycle. A setup-wide automation still gets the instance's, unchanged.
//
// Loaded once per (instance, binding) pair per evaluation pass and shared by every rule with the
// same pair, so a user with one derived setup costs one extra query per pass regardless of how many
// rules it produced. Rules with no instance never call this at all.

/**
 * The identity of one context. A per-binding automation and a setup-wide one from the same instance
 * resolve differently, so they cannot share a cache entry.
 */
export function contextKey(instanceId: number | null, bindingId: number | null): string {
  return `${instanceId ?? ''}:${bindingId ?? ''}`;
}

const phaseSelect = {
  key: true,
  name: true,
  context_notes: true,
  targets: { select: { param_key: true, value: true } },
} as const;

export async function loadParamContext(
  instanceId: number,
  bindingId: number | null = null,
): Promise<ParamContext | null> {
  const instance = await db.blueprintInstance.findUnique({
    where: { id: instanceId },
    select: {
      lifecycle_state: true,
      overrides: { select: { param_key: true, phase_key: true, value: true } },
      field_values: { select: { field_key: true, value: true } },
      blueprint: {
        select: {
          params: { select: { key: true, default_value: true } },
          fields: { select: { key: true, default_value: true } },
        },
      },
      current_phase: { select: phaseSelect },
    },
  });
  if (!instance) {
    log.debug({ instanceId }, 'param context: instance not found');
    return null;
  }

  // A per-binding automation reads the binding's phase, not the setup's — that is the whole point
  // of F11: two bound devices are legitimately in different phases at the same moment.
  const binding =
    bindingId === null
      ? null
      : await db.blueprintSlotBinding.findUnique({
          where: { id: bindingId },
          select: {
            lifecycle_state: true,
            overrides: { select: { param_key: true, phase_key: true, value: true } },
            field_values: { select: { field_key: true, value: true } },
            current_phase: { select: phaseSelect },
          },
        });
  if (bindingId !== null && !binding) {
    // The binding is gone (its device was removed). The automation's own FK is SetNull, so this is
    // a race rather than a steady state — hold it this pass rather than silently resolving against
    // the setup's phase, which would make it a different automation.
    log.debug({ instanceId, bindingId }, 'param context: binding not found — holding');
    return null;
  }

  const ctx = buildParamContext({
    overrides: instance.overrides,
    defaults: instance.blueprint.params,
    currentPhase: binding ? binding.current_phase : instance.current_phase,
    // Carried on the context so the run/hold gate and the resolved values come from one read of
    // one row — they cannot disagree about which setup they describe.
    lifecycle: instance.lifecycle_state,
    binding: binding ? { overrides: binding.overrides, lifecycle: binding.lifecycle_state } : null,
    fields: {
      binding: binding?.field_values ?? [],
      instance: instance.field_values,
      defaults: instance.blueprint.fields,
    },
  });
  log.debug(
    {
      instanceId,
      bindingId,
      phase: ctx.phase?.key ?? null,
      lifecycle: ctx.lifecycle,
      bindingLifecycle: ctx.bindingLifecycle,
      bindingOverrides: ctx.bindingOverrides,
      phaseOverrides: ctx.phaseOverrides,
      overrides: ctx.overrides,
      phaseTargets: ctx.phaseTargets,
      defaults: ctx.defaults,
      fields: ctx.fields,
    },
    'param context loaded (binding override → setup override → phase → default)',
  );
  return ctx;
}

/** One context per distinct (instance, binding) pair across a user's automations. */
export async function loadParamContexts(
  refs: { blueprint_instance_id: number | null; blueprint_binding_id: number | null }[],
): Promise<Map<string, ParamContext>> {
  const out = new Map<string, ParamContext>();
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.blueprint_instance_id === null) continue;
    const key = contextKey(ref.blueprint_instance_id, ref.blueprint_binding_id);
    if (seen.has(key)) continue;
    seen.add(key);
    const ctx = await loadParamContext(ref.blueprint_instance_id, ref.blueprint_binding_id);
    if (ctx) out.set(key, ctx);
  }
  return out;
}
