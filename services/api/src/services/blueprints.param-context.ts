import { db } from '../db';
import { buildParamContext, EMPTY_PARAM_CONTEXT, type ParamContext } from '@lattice/params';
import { createLogger } from '@lattice/logger';

const log = createLogger('api:blueprint-param-context');

// What `@param.x` / `@phase.x` mean *right now* for one derived setup (F10.1b).
//
// Derive stores references verbatim (see blueprints.derive.service.ts) — resolution happens at
// the moment something acts on them, against the instance's current phase and overrides. The
// automation-worker has the same loader for rule evaluation; this is the API-side one, used
// wherever the API is itself the thing dispatching (scene execution).
//
// The precedence and shaping live in @lattice/params — this only supplies the rows.
export async function loadParamContext(instanceId: number | null): Promise<ParamContext> {
  // A hand-written entity has no instance, so every value it holds is already a literal.
  if (instanceId === null) return EMPTY_PARAM_CONTEXT;

  const instance = await db.blueprintInstance.findUnique({
    where: { id: instanceId },
    select: {
      overrides: { select: { param_key: true, phase_key: true, value: true } },
      blueprint: { select: { params: { select: { key: true, default_value: true } } } },
      current_phase: {
        select: {
          key: true,
          name: true,
          context_notes: true,
          targets: { select: { param_key: true, value: true } },
        },
      },
    },
  });
  if (!instance) {
    log.warn({ instanceId }, 'param context: instance not found');
    return EMPTY_PARAM_CONTEXT;
  }

  return buildParamContext({
    overrides: instance.overrides,
    defaults: instance.blueprint.params,
    currentPhase: instance.current_phase,
  });
}
