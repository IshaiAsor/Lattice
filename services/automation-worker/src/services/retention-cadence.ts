import {
  catchUpLookbackMs,
  finestBucketSeconds,
  isDue,
  rollupIntervalSeconds,
} from '@lattice/retention';
import { db } from '../db/client';
import { env } from '../config/env.config';

// When the pass runs, and whether it is late (F18.17).
//
// Two independent questions, both answered from the same minute tick and both unanswerable by a
// cron string:
//
//   1. HOW OFTEN should the rollup half run? Not "nightly" — that was correct when the finest tier
//      was hard-coded to `1h` and the chart read raw for anything recent. Since F18.9 anyone can
//      configure `15m`, and a bucket built once a night does not exist for up to 24 hours after its
//      window closes. The interval comes from the finest bucket configured anywhere.
//   2. WAS a pass missed? node-cron is a wall-clock ticker with no catch-up. A worker restarting at
//      03:00, an evicted pod, or a laptop dev stack asleep skips the night silently — observed
//      live on 2026-08-26, with rollups stopped at the last manual sweep while raw ran to the
//      current minute and neither of the pass's log lines ever written.
//
// Both are answered by comparing `now` against `retention_runs`, which needs no cursor, no memory
// of missed occurrences, and survives a restart because the answer is in the database.

const TERMINAL = ['ok', 'failed'];

/**
 * The catalog codes any scope has a tier for, for the kinds that are switched on.
 *
 * Filtered by `retention_policy.enabled` because a kind that is off is neither rolled up nor pruned
 * — `rollUpScalars` returns immediately — so counting its tiers would schedule an interval pass
 * whose entire job is to claim the lock, find nothing to do, and write a run row about it every
 * five minutes.
 *
 * One small read per tier table, plus the policy. Written out rather than shared through one
 * object: Prisma's `distinct` is a per-model enum, so a single literal cannot type-check against
 * all five.
 */
async function configuredBucketCodes(): Promise<string[]> {
  const select = { bucket: true, data_kind: true };
  const distinct = ['bucket', 'data_kind'] as const;
  const [policies, platform, user, blueprint, device, action] = await Promise.all([
    db.retentionPolicy.findMany({ where: { enabled: true }, select: { data_kind: true } }),
    db.retentionPolicyTier.findMany({ distinct: [...distinct], select }),
    db.userRetentionTier.findMany({ distinct: [...distinct], select }),
    db.blueprintRetentionTier.findMany({ distinct: [...distinct], select }),
    db.deviceRetentionTier.findMany({ distinct: [...distinct], select }),
    db.actionRetentionTier.findMany({ distinct: [...distinct], select }),
  ]);
  const enabled = new Set(policies.map((p) => p.data_kind));
  return [...platform, ...user, ...blueprint, ...device, ...action]
    .filter((r) => enabled.has(r.data_kind))
    .map((r) => r.bucket);
}

export interface Cadence {
  /** The finest bucket configured anywhere, in seconds. Null when nothing is rolled up at all. */
  finestSeconds: number | null;
  /** Its catalog code, for display. */
  finestBucket: string | null;
  /** How often the rollup half should run, or null when the nightly pass already suffices. */
  intervalMs: number | null;
}

/**
 * What the tier lists say the cadence should be, right now.
 *
 * Re-read on every tick rather than cached: the whole point of the row is that **adding a `15m`
 * tier changes the cadence with no redeploy**, and a cache measured in anything longer than the
 * tick would put a staleness window in front of exactly that.
 */
export async function currentCadence(): Promise<Cadence> {
  const [codes, buckets] = await Promise.all([
    configuredBucketCodes(),
    db.retentionBucket.findMany({ select: { code: true, seconds: true } }),
  ]);
  const catalog = new Map(buckets.map((b) => [b.code, { seconds: b.seconds }]));
  const finestSeconds = finestBucketSeconds(codes, catalog);
  const intervalSeconds = rollupIntervalSeconds(
    finestSeconds,
    Math.ceil(env.retention.rollupMinIntervalMs / 1000),
  );
  const finestBucket =
    finestSeconds === null
      ? null
      : (buckets.find((b) => b.seconds === finestSeconds)?.code ?? null);

  return {
    finestSeconds,
    finestBucket,
    intervalMs: intervalSeconds === null ? null : intervalSeconds * 1000,
  };
}

/**
 * When a platform pass last FINISHED, and when a full (prune-inclusive) one did.
 *
 * User-scoped runs are excluded from both. An Apply touches one user's rows by design, so counting
 * it as "the platform was swept" would let one active user starve everybody else's rollups — the
 * tick would keep seeing a recent run and never fire.
 *
 * Only TERMINAL runs count, and a failure counts. A run still `queued` or `running` has not
 * finished anything, and treating it as a completion would let a wedged run suppress the tick
 * indefinitely — the exact failure this row exists to make impossible. A `failed` one, on the other
 * hand, must count: otherwise a persistently failing rollup is retried every single minute, and the
 * job history fills with 1,440 identical failures a day. Letting it reset the clock turns that into
 * one attempt per interval, which is the right backoff and still self-heals.
 */
export async function lastPlatformRuns(): Promise<{ anyAt: Date | null; fullAt: Date | null }> {
  const [any, full] = await Promise.all([
    db.retentionRun.findFirst({
      where: { scope_user_id: null, status: { in: TERMINAL }, finished_at: { not: null } },
      orderBy: { finished_at: 'desc' },
      select: { finished_at: true },
    }),
    db.retentionRun.findFirst({
      // Everything that is not an interval rollup prunes as well as rolls up.
      where: {
        scope_user_id: null,
        status: { in: TERMINAL },
        trigger: { not: 'rollup' },
        finished_at: { not: null },
      },
      orderBy: { finished_at: 'desc' },
      select: { finished_at: true },
    }),
  ]);
  return { anyAt: any?.finished_at ?? null, fullAt: full?.finished_at ?? null };
}

export type Due =
  /** The nightly pass was missed. Roll up AND prune, whatever the hour — a day late is worse. */
  | { kind: 'full'; reason: string }
  /** An interval rollup is due. Builds buckets, deletes nothing. */
  | { kind: 'rollup'; lookbackMs: number }
  | null;

/**
 * Decide what, if anything, this tick should run.
 *
 * Pure decision, no side effects, so the caller owns the claim and this can be reasoned about (and
 * logged) on its own. `full` wins when both apply: it does the rollup's work as well.
 */
export function decide(
  cadence: Cadence,
  last: { anyAt: Date | null; fullAt: Date | null },
  now: Date,
): Due {
  if (isDue(last.fullAt, env.retention.maxPassAgeMs, now)) {
    const hours = last.fullAt
      ? Math.round((now.getTime() - last.fullAt.getTime()) / 3_600_000)
      : null;
    return {
      kind: 'full',
      reason:
        hours === null
          ? 'no full pass has ever completed'
          : `the last full pass finished ${hours}h ago`,
    };
  }
  if (cadence.intervalMs === null) return null;
  if (!isDue(last.anyAt, cadence.intervalMs, now)) return null;
  return {
    kind: 'rollup',
    lookbackMs: catchUpLookbackMs(
      last.anyAt,
      now,
      cadence.intervalMs,
      env.retention.lookbackDays * 86_400_000,
    ),
  };
}
