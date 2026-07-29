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
