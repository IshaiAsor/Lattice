// Which tier a chart query should read from.
//
// Phase 1 asked "how wide is the range?" and answered with one of three hard-coded names. That is
// the line F18.9 has to delete: the candidate set is now DATA, so an admin who adds a `15m` tier
// gets `15m` charts with no code change, and a user whose device has no rollup tiers at all still
// gets a correct answer from raw alone.

import { RAW_SECONDS } from './kinds';
import type { ResolvedTier } from './tiers';

/**
 * The most points worth sending.
 *
 * No chart can draw more points than it has pixels, and the cost of the extra rows is paid twice —
 * once by Postgres and once by the browser deserialising them.
 */
export const MAX_POINTS = 5_000;

/**
 * Below this, a series stops looking like a series.
 *
 * Seven daily points across a week is a bar chart, not a trend, so a tier that coarse is passed
 * over in favour of the finest one that still has enough shape to draw.
 */
export const MIN_POINTS = 60;

/**
 * The sampling interval assumed for raw rows, in seconds.
 *
 * Raw is the one tier whose point count is not arithmetic — it depends on how often the device
 * actually reports, which varies per action and is not worth a query to find out before deciding
 * which query to run. A minute is the platform's common case and errs toward *over*-counting fast
 * sensors, which is the safe direction: over-counting drops raw for a wide range, and the tier
 * below it is always cheaper.
 */
export const ASSUMED_RAW_INTERVAL_SECONDS = 60;

export interface TierSelection {
  bucket: string;
  seconds: number;
  anchorOffsetSeconds: number;
  /**
   * `requested` — the caller named it and it was available.
   * `auto`      — chosen by the ladder below.
   * `fallback`  — nothing satisfied the ladder; this is the best that exists.
   */
  source: 'requested' | 'auto' | 'fallback';
}

export interface TierSelectionOptions {
  /** A bucket code the caller asked for. A request, not a command — see below. */
  requested?: string | null;
  now?: Date;
  maxPoints?: number;
  minPoints?: number;
  assumedRawIntervalSeconds?: number;
}

/** How many points this tier would produce over the range. */
function pointsFor(tier: ResolvedTier, rangeSeconds: number, rawInterval: number): number {
  const step = tier.seconds === RAW_SECONDS ? rawInterval : tier.seconds;
  return rangeSeconds / step;
}

/**
 * Does this tier's window still reach back to `from`?
 *
 * The decisive filter, and the reason retention and query planning belong in one package: asking a
 * 90-day-old range for raw rows that were pruned at 14 days returns an empty chart, and an empty
 * chart reads as "the device was off" rather than "those rows are gone".
 */
function reachesBack(tier: ResolvedTier, from: Date, now: Date): boolean {
  if (tier.keepDays === 0) return true; // forever
  return from.getTime() >= now.getTime() - tier.keepDays * 86_400_000;
}

/**
 * Pick the tier to read.
 *
 * The ladder, in order:
 *
 *   1. Drop any tier whose keep window no longer covers `from` — its rows are gone.
 *   2. Drop any tier that would draw more than `maxPoints`.
 *   3. Take the **coarsest** survivor that still yields at least `minPoints`.
 *
 * Step 3 is the one worth arguing about, and it is deliberately not "the finest survivor". Both
 * answers are legible; the coarsest sends far less over the wire for a chart that looks the same,
 * and it is what makes an added `15m` tier visible — on a two-day range raw is over the point cap,
 * `1h` is under the floor at 48 points, and `15m` at 192 is the only thing in between.
 *
 * `requested` lets a caller force a granularity — "show me the actual readings" on a narrow range —
 * but it is a request, not a command: a tier whose rows have been pruned is refused however
 * explicitly it was asked for, because the alternative is an empty chart with no explanation.
 */
export function selectTier(
  tiers: readonly ResolvedTier[],
  from: Date,
  to: Date,
  opts: TierSelectionOptions = {},
): TierSelection | null {
  if (tiers.length === 0) return null;

  const now = opts.now ?? new Date();
  const maxPoints = opts.maxPoints ?? MAX_POINTS;
  const minPoints = opts.minPoints ?? MIN_POINTS;
  const rawInterval = opts.assumedRawIntervalSeconds ?? ASSUMED_RAW_INTERVAL_SECONDS;
  const rangeSeconds = Math.max(0, (to.getTime() - from.getTime()) / 1000);

  const ascending = [...tiers].sort((a, b) => a.seconds - b.seconds);
  const available = ascending.filter((t) => reachesBack(t, from, now));

  const pick = (t: ResolvedTier, source: TierSelection['source']): TierSelection => ({
    bucket: t.bucket,
    seconds: t.seconds,
    anchorOffsetSeconds: t.anchorOffsetSeconds,
    source,
  });

  if (opts.requested) {
    const asked = available.find((t) => t.bucket === opts.requested);
    if (asked) return pick(asked, 'requested');
  }

  // Everything the caller could see has been pruned past this range. The coarsest tier is the one
  // most likely to still hold something, so answer with it rather than with nothing.
  if (available.length === 0) return pick(ascending[ascending.length - 1]!, 'fallback');

  const affordable = available.filter((t) => pointsFor(t, rangeSeconds, rawInterval) <= maxPoints);
  if (affordable.length === 0) {
    // Even the coarsest tier overruns the cap — a multi-year range on daily buckets. Take it
    // anyway; the caller's own limit will page it.
    return pick(available[available.length - 1]!, 'fallback');
  }

  const shapely = affordable.filter((t) => pointsFor(t, rangeSeconds, rawInterval) >= minPoints);
  if (shapely.length > 0) return pick(shapely[shapely.length - 1]!, 'auto');

  // Nothing has enough points — a range narrower than a single bucket of anything. The finest
  // affordable tier is the most detail available, which is the best answer that exists.
  return pick(affordable[0]!, 'auto');
}
