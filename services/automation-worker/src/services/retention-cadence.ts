import {
  catchUpLookbackMs,
  finestBucketSeconds,
  isJobDue,
  nextOccurrence,
  parseCron,
  prevOccurrence,
  rollupIntervalSeconds,
  RETENTION_JOBS,
  type CronFields,
  type RetentionJob,
} from '@lattice/retention';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { env } from '../config/env.config';

const log = createLogger('automation-worker:retention-cadence');

// When each of the four jobs runs, and whether any of them is late (F18.17 / F18.18).
//
// Two questions a cron string cannot answer on its own, both settled by comparing `now` against
// `retention_runs`:
//
//   1. HOW OFTEN should buckets be rebuilt? Not "nightly" — that was correct when the finest tier
//      was hard-coded to `1h`. Since F18.9 anyone can configure `15m`, and a bucket built once a
//      night does not exist for up to 24 hours after its window closes. With `cron` NULL the
//      interval still comes from the finest bucket configured anywhere; an admin may pin it.
//   2. WAS a slot missed? node-cron is a wall-clock ticker with no catch-up. A worker restarting at
//      03:00, an evicted pod, or a laptop dev stack asleep skips the night silently — observed live
//      on 2026-08-26, with rollups stopped at the last manual sweep while raw ran to the current
//      minute and neither of the pass's log lines ever written.
//
// SINCE F18.18 THIS IS THE WHOLE SCHEDULER. There is no `cron.schedule` for retention any more:
// each tick asks each job "when were you last due, and have you run since?", which needs no cursor,
// no memory of missed occurrences, and survives a restart because the answer is in the database.
// That also removes the class of bug where a registered task drifts from the row that configured it.

const TERMINAL = ['ok', 'failed'];

/** How late a pass may start and still be reported as its scheduled run rather than a catch-up. */
const ON_TIME_GRACE_MS = env.retention.onTimeGraceMs;

export interface JobSchedule {
  job: RetentionJob;
  /** Null on `bucket_build` means "derive from the finest configured tier". */
  cron: string | null;
  timezone: string;
  enabled: boolean;
  /** Parsed once per tick; null when `cron` is null or will not parse. */
  fields: CronFields | null;
}

/**
 * The four rows, with each expression parsed.
 *
 * A row whose expression will not parse is logged and treated as unscheduled rather than crashing
 * the tick — one bad string must not stop the other three jobs, and the fallback below keeps the
 * destructive work happening at all.
 */
export async function currentSchedules(): Promise<Map<RetentionJob, JobSchedule>> {
  const rows = await db.retentionSchedule.findMany({
    select: { job: true, cron: true, timezone: true, enabled: true },
  });
  const out = new Map<RetentionJob, JobSchedule>();

  for (const job of RETENTION_JOBS) {
    const row = rows.find((r) => r.job === job);
    // A missing row is possible only if somebody deleted one; fall back to the env default so the
    // job keeps running rather than silently stopping.
    const cron = row ? row.cron : job === 'bucket_build' ? null : env.retention.cron;
    let fields: CronFields | null = null;
    if (cron !== null) {
      try {
        fields = parseCron(cron);
      } catch (err) {
        log.error({ err, job, cron }, 'retention schedule will not parse — falling back');
        try {
          fields = parseCron(env.retention.cron);
        } catch {
          fields = null;
        }
      }
    }
    out.set(job, {
      job,
      cron,
      timezone: row?.timezone ?? 'UTC',
      enabled: row?.enabled ?? true,
      fields,
    });
  }
  return out;
}

/** The `retention_runs.job` value each schedule produces. */
export const MODE_OF: Record<RetentionJob, string> = {
  bucket_build: 'build',
  data_sweep: 'sweep',
  bucket_delete: 'delete',
  orphan_sweep: 'orphan',
};

export interface Cadence {
  /** The finest bucket configured anywhere, in seconds. Null when nothing is rolled up at all. */
  finestSeconds: number | null;
  /** Its catalog code, for display. */
  finestBucket: string | null;
  /** How often the rollup half should run, or null when a daily pass already suffices. */
  intervalMs: number | null;
}

/**
 * The codes any scope has a tier for, for the kinds that are switched on.
 *
 * Filtered by `retention_policy.enabled` because a kind that is off is neither rolled up nor pruned
 * — `rollUpScalars` returns immediately — so counting its tiers would schedule a build pass whose
 * entire job is to claim the lock, find nothing to do, and write a run row about it.
 *
 * One small read per tier table, plus the policy. Written out rather than shared through one object:
 * Prisma's `distinct` is a per-model enum, so a single literal cannot type-check against all five.
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

/**
 * What the tier lists say the build cadence should be, right now.
 *
 * Re-read on every tick rather than cached: the whole point is that **adding a `15m` tier changes
 * the cadence with no redeploy**, and a cache measured in anything longer than the tick would put a
 * staleness window in front of exactly that.
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
 * When each job last FINISHED, platform-wide.
 *
 * User-scoped runs are excluded. An Apply touches one user's rows by design, so counting it as "the
 * platform was swept" would let one active user starve everybody else's — the tick would keep seeing
 * a recent run and never fire.
 *
 * Only TERMINAL runs count, and a failure counts. A run still `queued` or `running` has not finished
 * anything, and treating it as a completion would let a wedged run suppress the tick indefinitely —
 * the exact failure F18.17 exists to make impossible. A `failed` one, on the other hand, must count:
 * otherwise a persistently failing job is retried every single minute and the history fills with
 * 1,440 identical failures a day. Letting it reset the clock is the right backoff and still
 * self-heals.
 *
 * A `full` run satisfies every job, because it did every job.
 */
export async function lastRunPerJob(): Promise<Map<string, Date>> {
  const rows = await db.retentionRun.groupBy({
    by: ['job'],
    where: { scope_user_id: null, status: { in: TERMINAL }, finished_at: { not: null } },
    _max: { finished_at: true },
  });

  const out = new Map<string, Date>();
  for (const r of rows) if (r._max.finished_at) out.set(r.job, r._max.finished_at);

  const full = out.get('full');
  if (full) {
    for (const job of RETENTION_JOBS) {
      const key = MODE_OF[job];
      const own = out.get(key);
      if (!own || own < full) out.set(key, full);
    }
  }
  return out;
}

export interface DueJob {
  job: RetentionJob;
  /** What to write in `retention_runs.job`. */
  mode: string;
  /** `cron` when it started near its slot, `catchup` when it is late. */
  trigger: 'cron' | 'catchup';
  /** Only meaningful for a build pass. */
  lookbackMs?: number;
  reason: string;
}

/**
 * Decide what, if anything, this tick should run.
 *
 * Pure, no side effects, so the caller owns the claim and this can be reasoned about — and logged —
 * on its own. Returns every due job in priority order; the caller runs at most one, since they all
 * contend for the same global lock and a backlog drains over successive ticks.
 *
 * BUILD IS FIRST on purpose. It is the only non-destructive job, the only one anybody is waiting on,
 * and running it before the deletes preserves the load-bearing order the single pass used to
 * guarantee for free: summarise before you delete the rows being summarised.
 */
export function decide(
  schedules: Map<RetentionJob, JobSchedule>,
  cadence: Cadence,
  last: Map<string, Date>,
  now: Date,
): DueJob[] {
  const due: DueJob[] = [];

  for (const job of RETENTION_JOBS) {
    const s = schedules.get(job);
    if (!s || !s.enabled) continue;
    const mode = MODE_OF[job];
    const lastAt = last.get(mode) ?? null;

    // `bucket_build` with no expression keeps F18.17's derived interval: the finest configured
    // bucket, floored. Everything else is a wall-clock schedule.
    if (job === 'bucket_build' && s.fields === null) {
      if (cadence.intervalMs === null) continue;
      if (lastAt !== null && now.getTime() - lastAt.getTime() < cadence.intervalMs) continue;
      due.push({
        job,
        mode,
        trigger: 'cron',
        lookbackMs: catchUpLookbackMs(
          lastAt,
          now,
          cadence.intervalMs,
          env.retention.lookbackDays * 86_400_000,
        ),
        reason: `derived from the finest configured bucket (${cadence.finestBucket ?? 'unknown'})`,
      });
      continue;
    }
    if (s.fields === null) continue;

    const slot = prevOccurrence(s.fields, s.timezone, now);
    if (!isJobDue(lastAt, slot, now)) continue;

    const lateMs = slot === null ? 0 : now.getTime() - slot.getTime();
    due.push({
      job,
      mode,
      trigger: lateMs <= ON_TIME_GRACE_MS ? 'cron' : 'catchup',
      // A pinned build reads back to its own slot, floored at two intervals so the bucket that just
      // closed is inside the window — the same rule the derived path uses.
      ...(job === 'bucket_build'
        ? {
            lookbackMs: catchUpLookbackMs(
              lastAt,
              now,
              Math.max(lateMs, 60_000),
              env.retention.lookbackDays * 86_400_000,
            ),
          }
        : {}),
      reason:
        lastAt === null
          ? 'has never run'
          : `due at ${slot?.toISOString() ?? 'unknown'}, last ran ${lastAt.toISOString()}`,
    });
  }

  return due;
}

/** When each job is next due, for the admin page. */
export function nextDueAt(
  s: JobSchedule,
  cadence: Cadence,
  lastAt: Date | null,
  now: Date,
): Date | null {
  if (!s.enabled) return null;
  if (s.fields === null) {
    if (s.job !== 'bucket_build' || cadence.intervalMs === null) return null;
    return new Date((lastAt?.getTime() ?? now.getTime()) + cadence.intervalMs);
  }
  return nextOccurrence(s.fields, s.timezone, now);
}
