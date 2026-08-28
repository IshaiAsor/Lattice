// Tier lists: what a scope stores, what the sweep actually applies, and what a tier list must
// satisfy before it may be stored at all.
//
// A tier list is the whole retention configuration for one (scope, kind): an ordered set of
// buckets, each with a keep window. `raw` is position 0 of that list rather than a separate
// kind-level window — which is what makes a per-action raw window fall out for free, and is the
// decision that rewrote Phase 1's raw path.

import {
  allowedForKind,
  formatSeconds,
  describeSeconds,
  whyNotAllowedForKind,
  isBucketAdmissible,
  badRequest,
  type BucketDef,
} from './buckets';
import { RAW_BUCKET, RAW_SECONDS, type DataKind } from './kinds';
import { clampKeepDays, rawFloorDays } from './windows';

/** One row of a tier list. `keepDays` of 0 means forever. */
export interface Tier {
  bucket: string;
  keepDays: number;
  position: number;
}

/** The platform's own tier, which alone carries a ceiling. `null` = uncapped. */
export interface PlatformTier extends Tier {
  maxKeepDays: number | null;
}

/**
 * The five scopes a tier list can be stored at, finest-first.
 *
 * Order is the resolution order, and it is the only place it is written down.
 */
export const TIER_SCOPES = ['action', 'device', 'blueprint', 'user', 'platform'] as const;

/** One day, in seconds. The granularity the two DATE-keyed rollup tables physically store. */
export const DAY_SECONDS = 86_400;

/**
 * The tier that governs a DATE-keyed rollup table, or null when the list has none (F18.23).
 *
 * `command_rollup_daily` and `device_availability_daily` have no bucket column — one row IS one
 * day — so a tier list does not name them the way `sensor_rollup.bucket` is named. Something has
 * to decide which entry in the list applies, and that decision is made in TWO places: the rollup
 * half (should these rows be built at all?) and the prune half (on whose window are they removed?).
 * Two copies of it disagreeing is what produced the bug this exists to fix.
 *
 * **The FINEST whole-day tier**, not the coarsest, because it is the one that describes the
 * granularity actually stored. A list of `raw → 1d → 1w` is answered by `1d`, which is both correct
 * and identical to the exact-match behaviour it replaces. A list of `raw → 1w` — legal, offered by
 * the editor, and previously matched by nothing — is answered by `1w`.
 *
 * Null means the list makes no statement about daily summaries at all. That is a real answer and
 * the caller must handle it: the rollup should not build rows nobody asked for, and the prune
 * should sweep away any that a previous configuration left behind. Before F18.23 it silently meant
 * "write them forever and never delete them", which is how a `raw`-only commands list — created by
 * the Phase 2 migration for every user whose legacy `daily_days` was NULL, chosen by nobody —
 * ended up accumulating rows that nothing on the platform would ever remove.
 */
export function dailyTierOf<T extends { seconds: number }>(tiers: readonly T[]): T | null {
  let best: T | null = null;
  for (const t of tiers) {
    if (t.seconds <= 0 || t.seconds % DAY_SECONDS !== 0) continue;
    if (best === null || t.seconds < best.seconds) best = t;
  }
  return best;
}
export type TierScope = (typeof TIER_SCOPES)[number];

/** A tier that was configured but cannot be applied, with the reason the API can show. */
export interface RejectedTier {
  bucket: string;
  reason: string;
}

/** A tier as the sweep and the chart see it: resolved, clamped, and with its size attached. */
export interface ResolvedTier {
  bucket: string;
  seconds: number;
  anchorOffsetSeconds: number;
  keepDays: number;
  position: number;
}

export interface ResolvedTiers {
  tiers: ResolvedTier[];
  /** Which scope the list came from — what the UI shows as "inherited from your device". */
  source: TierScope;
  rejected: RejectedTier[];
}

export interface TierResolutionInput {
  kind: DataKind;
  /** The `retention_buckets` catalog, keyed by code. */
  buckets: ReadonlyMap<string, BucketDef>;
  platform: readonly PlatformTier[];
  user?: readonly Tier[];
  blueprint?: readonly Tier[];
  device?: readonly Tier[];
  action?: readonly Tier[];
  /** The finest bucket anyone may choose for this kind, as a catalog code. */
  minBucket?: string | null;
}

/**
 * The tier list that applies, and where it came from.
 *
 * **The whole list wins, not tier by tier.** The most specific scope with *any* rows for this kind
 * supplies every tier; the scopes below it are not consulted at all. Merging tier-by-tier would
 * make F18.12's own acceptance criterion ambiguous — "removing the action's tier falls back to the
 * device's" has no answer if an action list could ever be half-inherited. It also means a user
 * looking at a device's tiers is looking at the complete truth for that device.
 *
 * Clamping is per bucket against the platform row for the *same* bucket. A scope that keeps a
 * bucket the platform does not configure is uncapped for it — the platform expresses a ceiling by
 * carrying the bucket, not by omitting it.
 *
 * Does no I/O and takes the catalog as an argument, because the worker resolves this per action for
 * every action in the system. A resolver that queried would be an N+1 by construction.
 */
export function resolveTiers(input: TierResolutionInput): ResolvedTiers {
  const { kind, buckets, platform } = input;

  const chosen: [TierScope, readonly Tier[] | undefined][] = [
    ['action', input.action],
    ['device', input.device],
    ['blueprint', input.blueprint],
    ['user', input.user],
    ['platform', platform],
  ];
  const hit = chosen.find(([, list]) => list !== undefined && list.length > 0);
  // Nothing configured anywhere, not even a platform row. Keep everything: an absent policy is a
  // configuration accident, and the cost of guessing wrong is unrecoverable.
  if (!hit) return { tiers: [], source: 'platform', rejected: [] };
  const [source, list] = hit as [TierScope, readonly Tier[]];

  const ceilings = new Map(platform.map((t) => [t.bucket, t.maxKeepDays]));
  const floor = input.minBucket ? (buckets.get(input.minBucket)?.seconds ?? null) : null;

  const tiers: ResolvedTier[] = [];
  const rejected: RejectedTier[] = [];
  const seen = new Set<string>();

  for (const t of list) {
    if (seen.has(t.bucket)) {
      rejected.push({ bucket: t.bucket, reason: 'listed twice' });
      continue;
    }
    seen.add(t.bucket);

    const def = buckets.get(t.bucket);
    if (!def) {
      // The FK makes this unreachable from the database, but a catalog row deleted between the load
      // and the resolve would land here rather than crashing a nightly pass.
      rejected.push({ bucket: t.bucket, reason: 'not in the bucket catalog' });
      continue;
    }
    if (!allowedForKind(kind, def.seconds)) {
      rejected.push({ bucket: t.bucket, reason: whyNotAllowedForKind(kind, def.seconds) });
      continue;
    }
    // `raw` is never below the floor: the floor is about how fine a *summary* may be, and raw is
    // not a summary. A `min_bucket` of `15m` still keeps raw rows for as long as the raw tier says.
    if (floor !== null && def.seconds !== RAW_SECONDS && def.seconds < floor) {
      rejected.push({
        bucket: t.bucket,
        reason: `finer than the ${formatSeconds(floor)} minimum this platform allows`,
      });
      continue;
    }

    tiers.push({
      bucket: t.bucket,
      seconds: def.seconds,
      anchorOffsetSeconds: def.anchorOffsetSeconds,
      // A platform list is its own ceiling, so clamping it against itself is a no-op — but running
      // it through the same path keeps one code path rather than a branch that could disagree.
      keepDays: clampKeepDays(t.keepDays, ceilings.get(t.bucket) ?? null),
      position: t.position,
    });
  }

  // Sorted by size, not by the stored `position`. The fold chain reads this list in order and each
  // tier is built from its predecessor, so an out-of-order position must not be able to make a
  // coarse bucket fold from a finer one that has not been written yet. Positions are renumbered to
  // match, so what is stored and what applies can be compared directly.
  tiers.sort((a, b) => a.seconds - b.seconds);
  for (let i = 0; i < tiers.length; i++) tiers[i]!.position = i;

  return { tiers, source, rejected };
}

export interface TierListValidation {
  kind: DataKind;
  buckets: ReadonlyMap<string, BucketDef>;
  /** How far back the nightly rollup reads, in days — the raw floor is derived from it. */
  lookbackDays: number;
  minBucket?: string | null;
  /** Platform ceilings, when validating a list that is not itself the platform's. */
  ceilings?: ReadonlyMap<string, number | null>;
}

/**
 * Refuse a tier list that cannot be built, naming what would work instead.
 *
 * Everything here is a constraint on the **list**, never on a size. `90m` is a perfectly legal
 * bucket — it simply cannot sit directly above `1h`, because 5400/3600 is 1.5 and half a bucket
 * cannot be folded. That distinction is why the catalog can stay open to any admissible size while
 * the chain stays sound.
 */
export function assertTierList(list: readonly Tier[], v: TierListValidation): void {
  const { kind, buckets } = v;

  if (list.length === 0) throw badRequest('A tier list needs at least the raw tier');

  const seen = new Set<string>();
  for (const t of list) {
    if (seen.has(t.bucket)) throw badRequest(`The ${t.bucket} tier is listed twice`);
    seen.add(t.bucket);
    if (!Number.isInteger(t.keepDays) || t.keepDays < 0)
      throw badRequest(
        `The ${t.bucket} tier needs a whole number of days, or 0 for forever — got ${t.keepDays}`,
      );
    if (t.keepDays > 3650)
      throw badRequest(`The ${t.bucket} tier may not exceed 3650 days — use 0 for forever`);
  }

  // Raw is mandatory. Without it the list says nothing about how long the readings themselves are
  // kept, and the sweep would have to invent an answer for the one window that cannot be recovered.
  const raw = list.find((t) => t.bucket === RAW_BUCKET);
  if (!raw)
    throw badRequest(
      `Every tier list starts with the raw tier — it sets how long the readings themselves are kept`,
    );

  const resolved = list.map((t) => {
    const def = buckets.get(t.bucket);
    if (!def) throw badRequest(`${t.bucket} is not a bucket in the catalog`);
    if (!allowedForKind(kind, def.seconds))
      throw badRequest(
        `${t.bucket} cannot be used for ${kind} history — ${whyNotAllowedForKind(kind, def.seconds)}`,
      );
    return { tier: t, def };
  });

  // There is deliberately NO cap on how many tiers a list may hold (user's call, 2026-08-26). A
  // count was the wrong axis to limit: cost is dominated by the FINEST bucket, not the number of
  // them -- a 30m tier costs 48 rollup rows per sensor per day while every coarser tier together
  // costs about one. `min_bucket` bounds that axis, and the chain rule below bounds length on its
  // own: each tier must be a whole multiple of the one below it, so a list cannot exceed roughly
  // twenty entries between the 60s floor and the 3650-day ceiling.

  const floor = v.minBucket ? (buckets.get(v.minBucket)?.seconds ?? null) : null;
  if (floor !== null) {
    const tooFine = resolved.find(({ def }) => def.seconds !== RAW_SECONDS && def.seconds < floor);
    if (tooFine)
      throw badRequest(
        `${tooFine.def.code} is finer than the ${formatSeconds(floor)} minimum this platform allows`,
      );
  }

  if (v.ceilings) {
    for (const { tier, def } of resolved) {
      const ceiling = v.ceilings.get(tier.bucket);
      if (ceiling === undefined || ceiling === null) continue;
      if (tier.keepDays === 0 || tier.keepDays > ceiling)
        throw badRequest(
          `The ${def.code} tier (${tier.keepDays === 0 ? 'forever' : `${tier.keepDays} days`}) is ` +
            `above the ceiling of ${ceiling} day${ceiling === 1 ? '' : 's'} — lower the ${def.code} ` +
            `tier first, or ask an admin to raise the ceiling.`,
        );
    }
  }

  // The raw floor. THE most important invariant in Phase 2: the finest rollup tier is built by
  // reading raw rows, so a raw window shorter than the rollup lookback deletes readings before they
  // were ever aggregated — the user shortens raw to save space and silently destroys the long-range
  // history they were compressing into.
  const rollupTiers = resolved.filter(({ def }) => def.seconds !== RAW_SECONDS);
  if (rollupTiers.length > 0) {
    const min = rawFloorDays(v.lookbackDays);
    if (raw.keepDays !== 0 && raw.keepDays < min)
      throw badRequest(
        `Raw readings must be kept at least ${min} day${min === 1 ? '' : 's'} while any rollup ` +
          `tier exists — the rollups are built from them, and a shorter window deletes readings ` +
          `before they have been summarised.`,
      );
  }

  assertChainDivisible(rollupTiers.map(({ def }) => def));
}

/**
 * Each rollup tier must fold from the one below it.
 *
 * The refusal names both numbers and suggests real predecessors, because the rule is not obvious
 * from the sizes: `90m` above `1h` looks fine until you divide.
 */
export function assertChainDivisible(defs: readonly BucketDef[]): void {
  const sorted = [...defs].sort((a, b) => a.seconds - b.seconds);
  for (let i = 1; i < sorted.length; i++) {
    const parent = sorted[i]!;
    const child = sorted[i - 1]!;
    if (parent.seconds % child.seconds === 0) continue;
    const options = properDivisors(parent.seconds)
      .filter(isBucketAdmissible)
      .slice(-2)
      .map(formatSeconds);
    throw badRequest(
      `${formatSeconds(parent.seconds)} cannot fold from ${formatSeconds(child.seconds)} — ` +
        `${describeSeconds(parent.seconds)} is ${round2(parent.seconds / child.seconds)}× ` +
        `${describeSeconds(child.seconds)}, not a whole number of them` +
        (options.length > 0 ? `; use ${options.join(' or ')} below it` : ''),
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every divisor of `n` below it, ascending. Used only to suggest a workable predecessor. */
function properDivisors(n: number): number[] {
  const out: number[] = [];
  for (let d = 1; d * d <= n; d++) {
    if (n % d !== 0) continue;
    out.push(d);
    if (d !== n / d) out.push(n / d);
  }
  return out.filter((d) => d < n).sort((a, b) => a - b);
}
