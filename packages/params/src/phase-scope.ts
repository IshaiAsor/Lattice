// Phase scoping (F10 follow-up). A blueprint automation (rule / scene / pipeline) may declare the
// set of phase keys it is active in. This is the single gate, shared by automation-worker (rule
// evaluation + pipeline triggers) and api (scene execution) so they cannot
// disagree — the same reason resolveParam lives here.
//
// Pure and read-time: the gate is evaluated against the instance's *current* phase, so advancing
// a phase never rewrites the automation. An empty scope means "active in every phase", which is
// the default and exactly today's behaviour for every automation that doesn't set one.

/**
 * True when an automation with this `scope` is active while the instance is in `currentPhaseKey`.
 *
 * - Empty `scope` ⇒ always active (all phases).
 * - Non-empty `scope` ⇒ active only when `currentPhaseKey` is one of its keys. A null current
 *   phase (an instance with no phases, or one that has fallen out of its lifecycle) is never in
 *   any non-empty scope, so the automation is inert — it cannot be "in" a phase that isn't set.
 */
export function isPhaseInScope(
  scope: readonly string[] | null | undefined,
  currentPhaseKey: string | null | undefined,
): boolean {
  if (!scope || scope.length === 0) return true;
  return currentPhaseKey != null && scope.includes(currentPhaseKey);
}

// ── Setup lifecycle (F10.13) ────────────────────────────────────────────────────────────────
//
// A derived setup is not running until the user starts it, and can be stopped again. That is a
// coarser gate than phase scope and sits in front of it: a stopped setup does *nothing*, whether
// or not the automation declared phases.

export type InstanceLifecycle = 'not_started' | 'running' | 'stopped';

/**
 * Whether a setup is live. Null/undefined means the automation belongs to no blueprint instance at
 * all — a hand-written rule — and those are always live, which is what keeps this gate invisible
 * to everything outside blueprints.
 */
export function isInstanceRunning(state: string | null | undefined): boolean {
  return state == null || state === 'running';
}

/**
 * The single question every automation site actually asks: may this rule / scene / pipeline act
 * right now? Two gates, in order of coarseness — is its setup running, and is it in scope for the
 * phase that setup is in.
 *
 * Both live here rather than in each service because the three callers (rule engine, pipeline
 * triggers, scene execution) must not disagree: an automation that fires in one path and is held
 * in another is a bug no test in a single service would catch.
 *
 * Note that a stopped setup holds *everything*, emergency rules included. Stopping is meant to be
 * "this setup is off", not "this setup is off except the parts that matter".
 *
 * `bindingLifecycleState` is one binding's own gate (F11.3), passed only by a per-binding
 * automation. Omitting it is "this automation belongs to the setup, not to one bound device", which
 * is why every pre-F11 call site keeps its exact meaning with three arguments.
 */
export function isAutomationLive(
  scope: readonly string[] | null | undefined,
  currentPhaseKey: string | null | undefined,
  lifecycleState: string | null | undefined,
  bindingLifecycleState?: string | null,
): boolean {
  return (
    isInstanceRunning(lifecycleState) &&
    isInstanceRunning(bindingLifecycleState) &&
    isPhaseInScope(scope, currentPhaseKey)
  );
}

/**
 * A binding is live only while its setup is (F11.3). One value rather than two so no caller can
 * check the binding and forget the setup — the setup's state wins whenever it is not running, which
 * is what makes stopping the whole setup hold every binding at once.
 */
export function effectiveLifecycle(
  bindingState: string | null | undefined,
  instanceState: string | null | undefined,
): string {
  if (!isInstanceRunning(instanceState)) return instanceState ?? 'stopped';
  return bindingState ?? 'running';
}
