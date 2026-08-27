// How OFTEN the pass runs — derived from the tier list rather than fixed in a cron string (F18.17).
//
// Phase 2 made every retention DECISION data: the tier sizes, the counts, the windows, the
// ceilings. The cadence was the one thing left frozen — `RETENTION_CRON` at 03:00, overridden
// nowhere — and a fixed nightly pass stopped being correct the moment a `15m` tier became
// configurable. **A bucket that is only built at 03:00 does not exist for up to 24 hours after its
// window closes**, which a chart draws as a gap at its right-hand edge rather than as data not yet
// folded. Prune has the mirror of the same problem: a 2-day raw window enforced up to 3 days late.
//
// So the two halves stop sharing a schedule:
//
//   ROLLUP  runs on the interval derived here — cheap, incremental, idempotent, and the half whose
//           output someone is looking at right now.
//   PRUNE   stays on its own quiet-hour cron — deleting is neither cheap nor reversible, and there
//           is no freshness argument for doing it more often.
//
// Everything here is pure arithmetic over the catalog, so `api` can DISPLAY the cadence the worker
// ENFORCES instead of each deriving its own and disagreeing.

/**
 * The floor under the derived interval, in seconds.
 *
 * Without it a `60s` custom bucket — admissible, and someone will make one — turns the sweep into a
 * permanent background load on the biggest tables in the system. Five minutes is the point where
 * the pass is still comfortably shorter than the gap between passes on any realistic deployment.
 */
export const MIN_ROLLUP_INTERVAL_SECONDS = 300;

/**
 * At or above this, there is no interval pass at all.
 *
 * A `1d` bucket closes at midnight and the nightly pass builds it a few hours later; nothing is
 * meaningfully stale, and an extra ticker would exist only to discover it has nothing to do. The
 * interval pass is for buckets the nightly one cannot keep up with, which means sub-daily ones.
 */
export const ROLLUP_INTERVAL_CEILING_SECONDS = 86_400;

/**
 * The finest bucket configured ANYWHERE, in seconds — or null when nothing is rolled up at all.
 *
 * Deliberately over the CONFIGURED buckets rather than the RESOLVED ones. Resolution is
 * whole-list-wins, so a `15m` tier at the user scope may in fact be shadowed at every device below
 * it and never actually apply — but establishing that costs a resolution per action, and the only
 * consequence of being wrong is running slightly more often than strictly necessary. Erring the
 * other way would mean a bucket nobody builds.
 *
 * `raw` is skipped: it has no grid and is never built, only kept.
 */
export function finestBucketSeconds(
  configuredCodes: Iterable<string>,
  buckets: ReadonlyMap<string, { seconds: number }>,
): number | null {
  let finest: number | null = null;
  for (const code of configuredCodes) {
    const seconds = buckets.get(code)?.seconds;
    // An unknown code cannot happen — every `bucket` column FKs to the catalog — but guessing a
    // duration for one would be worse than ignoring it.
    if (seconds === undefined || seconds <= 0) continue;
    if (finest === null || seconds < finest) finest = seconds;
  }
  return finest;
}

/**
 * The interval the rollup half should run at, or null when the nightly pass is already enough.
 *
 * Null is a real answer and not an error: it is what a deployment with nothing finer than `1d`
 * configured should get, and the caller schedules no interval pass at all.
 */
export function rollupIntervalSeconds(
  finestSeconds: number | null,
  floorSeconds: number = MIN_ROLLUP_INTERVAL_SECONDS,
): number | null {
  if (finestSeconds === null || finestSeconds <= 0) return null;
  if (finestSeconds >= ROLLUP_INTERVAL_CEILING_SECONDS) return null;
  return Math.max(finestSeconds, floorSeconds);
}

/**
 * Is a pass overdue?
 *
 * **This is the half that makes a missed pass survivable.** node-cron is a wall-clock ticker with
 * no catch-up: if the worker is restarting, the pod is evicted, or a laptop dev stack is asleep at
 * 03:00, that night is simply skipped, silently, with nothing written anywhere to say so. Asking
 * "how long since the last one finished?" on a short tick needs no memory of missed occurrences and
 * no cursor — a worker that was down comes back and sweeps, rather than waiting for tomorrow.
 *
 * A `null` last-run means nothing has ever completed, which is due by definition.
 */
export function isDue(lastFinishedAt: Date | null, everyMs: number, now: Date): boolean {
  if (lastFinishedAt === null) return true;
  return now.getTime() - lastFinishedAt.getTime() >= everyMs;
}

/** When the next pass is due, for display. Null when nothing has run and it is due now. */
export function dueAt(lastFinishedAt: Date | null, everyMs: number): Date | null {
  return lastFinishedAt === null ? null : new Date(lastFinishedAt.getTime() + everyMs);
}

/**
 * How far back an interval pass should look for buckets to rebuild.
 *
 * The nightly pass reads `RETENTION_LOOKBACK_DAYS` (3 days) of raw per action — correct once a
 * night, and **96× the read volume if it ran every fifteen minutes**. An interval pass only has to
 * rebuild what could have changed since the last one finished, so the gap IS the lookback.
 *
 * Two bounds on that gap:
 *
 *   floor `2 × everyMs`  the bucket that just closed lies entirely in the previous interval, and
 *                        `rollUpScalars` uses this same span to decide WHICH actions have anything
 *                        worth reading. One interval of lookback would step over the very bucket
 *                        the pass exists to build.
 *   ceiling `maxMs`      a worker down for a week must not come back and read a week of raw in one
 *                        pass. It catches up over successive passes instead — every upsert is
 *                        idempotent, so walking backwards costs nothing but time.
 */
export function catchUpLookbackMs(
  lastFinishedAt: Date | null,
  now: Date,
  everyMs: number,
  maxMs: number,
): number {
  if (lastFinishedAt === null) return maxMs;
  const gap = now.getTime() - lastFinishedAt.getTime();
  return Math.min(Math.max(gap, 2 * everyMs), maxMs);
}
