// Who may sweep while who else is sweeping.
//
// Pure, and here rather than in either service, because BOTH claim: `api` claims for an admin's or
// a user's "Apply now" (it has to answer 409 synchronously, in the request), and
// automation-worker claims for the nightly cron. Two implementations of "does this conflict?" is
// two chances to disagree about whether a user sweep may run during the platform pass — and the
// answer decides whether two processes issue overlapping DELETEs against the same rows.
//
// The INSERT and the advisory lock stay in each service; only the RULE lives here.

/** The key a claim would hold. `null` scope = a platform-wide sweep. */
export function sweepLockKey(scopeUserId: number | null): string {
  return scopeUserId === null ? 'global' : `user:${scopeUserId}`;
}

export const GLOBAL_LOCK_KEY = 'global';

/**
 * The advisory-lock id both services take before deciding.
 *
 * Arbitrary but fixed, and it must be the SAME number in both — an advisory lock only serialises
 * callers that ask for the same id, so two services using different ids would each be perfectly
 * serialised against themselves and not at all against each other.
 */
export const RETENTION_LOCK_ID = 918_273_641;

export interface ActiveSweep {
  id: number;
  lockKey: string | null;
  trigger: string;
  status: string;
}

/**
 * The first active sweep that blocks this claim, or null if it may proceed.
 *
 *   claiming global   → refused while ANY run is active, global or any user's.
 *   claiming user N   → refused while global is active, or user:N is.
 *   claiming user N   → NOT refused by user:M. Their rows are disjoint and ownership-scoped, and
 *                       serialising them would make one user's Apply wait on a stranger's.
 *
 * A global claim that loses still inserts as `queued` (the caller's job), which blocks new user
 * claims while it waits — writer preference, so the nightly pass cannot be starved by a stream of
 * user Applies.
 */
export function findSweepConflict(
  scopeUserId: number | null,
  active: readonly ActiveSweep[],
): ActiveSweep | null {
  if (scopeUserId === null) return active[0] ?? null;
  const mine = sweepLockKey(scopeUserId);
  return active.find((r) => r.lockKey === GLOBAL_LOCK_KEY || r.lockKey === mine) ?? null;
}

/**
 * What a run is, in a sentence a person reads in a 409.
 *
 * Lives here because both services refuse a claim and both name what is already running. Since
 * F18.17 there are five triggers, and two of them would be actively misleading unlabelled: a
 * `rollup` is not a "cleanup" at all — it deletes nothing — and `catchup` is the nightly pass run
 * late, which nobody outside the code calls a catchup.
 */
export function describeTrigger(trigger: string): string {
  switch (trigger) {
    case 'cron':
    case 'catchup':
      return 'nightly cleanup';
    case 'rollup':
      return 'summary rebuild';
    case 'admin':
      return 'platform cleanup';
    case 'user':
      return 'cleanup';
    default:
      return 'cleanup';
  }
}
