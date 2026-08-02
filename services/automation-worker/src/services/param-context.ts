import { buildParamContext, type ParamContext } from '@lattice/params';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';

const log = createLogger('automation-worker:params');

// Loads the resolution context for a blueprint instance (F10.1b): what `@param.x` / `@phase.x`
// mean *right now* for one derived setup. The precedence and shaping live in @lattice/params —
// this only supplies the rows.
//
// Loaded once per evaluation pass and shared by every rule of the same instance, so a user with
// one derived setup costs one extra query per pass regardless of how many rules it produced.
// Rules with no instance never call this at all.

export async function loadParamContext(instanceId: number): Promise<ParamContext | null> {
  const instance = await db.blueprintInstance.findUnique({
    where: { id: instanceId },
    select: {
      lifecycle_state: true,
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
    log.debug({ instanceId }, 'param context: instance not found');
    return null;
  }

  const ctx = buildParamContext({
    overrides: instance.overrides,
    defaults: instance.blueprint.params,
    currentPhase: instance.current_phase,
    // Carried on the context so the run/hold gate and the resolved values come from one read of
    // one row — they cannot disagree about which setup they describe.
    lifecycle: instance.lifecycle_state,
  });
  log.debug(
    {
      instanceId,
      phase: ctx.phase?.key ?? null,
      lifecycle: ctx.lifecycle,
      phaseOverrides: ctx.phaseOverrides,
      overrides: ctx.overrides,
      phaseTargets: ctx.phaseTargets,
      defaults: ctx.defaults,
    },
    'param context loaded (precedence: phase override → override → phase → default)',
  );
  return ctx;
}

// One context per distinct instance across a user's rules.
export async function loadParamContexts(
  instanceIds: (number | null)[],
): Promise<Map<number, ParamContext>> {
  const out = new Map<number, ParamContext>();
  for (const id of new Set(instanceIds.filter((i): i is number => i !== null))) {
    const ctx = await loadParamContext(id);
    if (ctx) out.set(id, ctx);
  }
  return out;
}
