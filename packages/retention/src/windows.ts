// Keep-window arithmetic: how a user's choice, a platform default and an admin ceiling combine into
// the one number a DELETE is allowed to use.
//
// Two encodings meet in this file and they are deliberately different:
//
//   `days = 0`     KEEP FOREVER. The safe reading for a number that drives DELETEs — a
//                  misconfigured row keeps too much rather than erasing someone's history.
//   `ceiling null` UNCAPPED. Not 0, because a ceiling of 0 would otherwise mean "cap everyone at
//                  forever", which is no cap at all and the opposite of what an admin typing a
//                  limit intends.
//
// So "forever" is the LARGEST value even though it is numerically the smallest, and clamping has to
// treat it as infinity rather than reaching for Math.min.
//
// Phase 1's ceiling ASSERTIONS used to live here too (`clampDays`, `aboveCeiling`,
// `assertWithinCeiling` and its `default`-named alias). They are gone: `assertTierList` in
// tiers.ts enforces ceilings per tier, which is what F18.11 needed and what the three-column
// versions could not express. What is left is the arithmetic that still has callers.

/**
 * The floor under a raw tier, in days.
 *
 * The finest rollup tier is built by reading raw rows, so a raw window shorter than the rollup
 * lookback deletes rows before they were ever aggregated — the user loses the long-range history
 * they were trying to compress into. Two days is the absolute minimum whatever the lookback is set
 * to, because the nightly pass can miss a night.
 */
const MIN_RAW_KEEP_DAYS = 2;

export function rawFloorDays(lookbackDays: number): number {
  return Math.max(lookbackDays, MIN_RAW_KEEP_DAYS);
}

/**
 * One keep window clamped to its ceiling.
 *
 * Forever loses to any ceiling: an admin who set a limit meant it to bind the unlimited case most
 * of all. This is the single rule the whole encoding rests on, so it lives in exactly one function
 * and everything else delegates.
 */
export function clampKeepDays(chosen: number, ceiling: number | null): number {
  if (ceiling === null) return chosen;
  if (chosen === 0) return ceiling;
  return Math.min(chosen, ceiling);
}

/**
 * The cutoff a DELETE should use, or null when nothing should be deleted.
 *
 * Null for both "keep forever" and "this kind is switched off" on purpose: the caller must not be
 * able to accidentally turn either into a Date, and a single null check at the call site is harder
 * to get wrong than remembering which of the two conditions applied.
 */
export function pruneCutoff(days: number | null, enabled: boolean, now: Date): Date | null {
  if (!enabled) return null;
  if (days === null || days <= 0) return null;
  return new Date(now.getTime() - days * 86_400_000);
}
