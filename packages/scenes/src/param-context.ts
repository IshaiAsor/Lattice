import { db } from '@lattice/prisma-client';
import { buildParamContext, EMPTY_PARAM_CONTEXT, type ParamContext } from '@lattice/params';
import { createLogger } from '@lattice/logger';

const log = createLogger('scenes:blueprint-param-context');

// What `@param.x` / `@phase.x` / `@field.x` mean *right now* for one derived setup (F10.1b).
//
// Derive stores references verbatim (see blueprints.derive.service.ts) — resolution happens at
// the moment something acts on them, against the instance's current phase and overrides. The
// automation-worker has the same loader for rule evaluation; this is the on-demand one, used
// wherever a *user gesture* is the thing dispatching — the API executing a scene from the
// dashboard, and google-home executing the same scene from a voice command.
//
// It lives here rather than in @lattice/params because it reads the database, and @lattice/params
// is a pure library two unit suites import directly; giving it a Prisma client would make every
// consumer of a string-resolution helper construct one.
//
// A per-device entity (F11.2) passes its `blueprint_binding_id` and resolves against that binding
// instead: its own overrides, its own answers, and its own place in its own profile's lifecycle.
//
// The precedence and shaping live in @lattice/params — this only supplies the rows.

const phaseSelect = {
  key: true,
  name: true,
  context_notes: true,
  targets: { select: { param_key: true, value: true } },
} as const;

export async function loadParamContext(
  instanceId: number | null,
  bindingId: number | null = null,
): Promise<ParamContext> {
  // A hand-written entity has no instance, so every value it holds is already a literal.
  if (instanceId === null) return EMPTY_PARAM_CONTEXT;

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
    log.warn({ instanceId }, 'param context: instance not found');
    return EMPTY_PARAM_CONTEXT;
  }

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

  return buildParamContext({
    overrides: instance.overrides,
    defaults: instance.blueprint.params,
    // A per-device entity is in whatever phase *its own device* is in, which is the only phase that
    // can be right for it once two bound devices follow different profiles.
    currentPhase: binding ? binding.current_phase : instance.current_phase,
    lifecycle: instance.lifecycle_state,
    binding: binding ? { overrides: binding.overrides, lifecycle: binding.lifecycle_state } : null,
    fields: {
      binding: binding?.field_values ?? [],
      instance: instance.field_values,
      defaults: instance.blueprint.fields,
    },
  });
}
