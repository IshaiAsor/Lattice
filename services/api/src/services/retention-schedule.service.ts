import {
  MIN_ROLLUP_INTERVAL_SECONDS,
  MIN_SWEEP_INTERVAL_SECONDS,
  RETENTION_JOBS,
  assertBuildKeepsUpWithRaw,
  assertScheduleAdmissible,
  badRequest,
  describeGap,
  describeSchedule,
  dueAt,
  finestBucketSeconds,
  isKnownTimeZone,
  isRetentionJob,
  nextOccurrence,
  occurrenceGaps,
  parseCron,
  rollupIntervalSeconds,
  type RetentionJob,
} from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService } from './retention-activity.service';

// When each retention job runs, and letting an admin change it (F18.17 / F18.18).
//
// F18.17 made the build cadence DERIVED rather than configured — it comes from the finest bucket
// anyone has a tier for, so **adding a `15m` tier changes it with no redeploy**. Excellent, and
// completely invisible: an admin who added that tier had no way to tell the cadence had moved, and
// the row's whole complaint was about a schedule nobody could see being wrong for months. So this
// started as a read-only view of the derived figure.
//
// F18.18 made the other three real. `RETENTION_CRON` was the last piece of retention policy that
// still needed a redeploy, and it was covering three jobs that want three different hours: deleting
// a million raw readings, deleting a few thousand summary rows, and cleaning up after a tier
// somebody removed this morning.
//
// The QUERIES here are deliberately duplicated from the worker (each service owns its own Prisma
// client); the ARITHMETIC is not, because a page that states a schedule different from the one being
// enforced is worse than a page that states nothing.

/** Same defaults the worker reads, read the same way, so the two cannot disagree. */
const MIN_INTERVAL_MS = Number(
  process.env['RETENTION_ROLLUP_MIN_INTERVAL_MS'] ?? String(MIN_ROLLUP_INTERVAL_SECONDS * 1000),
);
const MIN_SWEEP_MS = Number(
  process.env['RETENTION_MIN_SWEEP_INTERVAL_MS'] ?? String(MIN_SWEEP_INTERVAL_SECONDS * 1000),
);
const FALLBACK_CRON = process.env['RETENTION_CRON'] ?? '0 0 3 * * *';

const TERMINAL = ['ok', 'failed'];

/** The `retention_runs.job` value each schedule produces. Mirrors the worker's `MODE_OF`. */
const MODE_OF: Record<RetentionJob, string> = {
  bucket_build: 'build',
  data_sweep: 'sweep',
  bucket_delete: 'delete',
  orphan_sweep: 'orphan',
};

/** What a person is told each job does, so "bucket deletion" is not a guess. */
const JOB_COPY: Record<RetentionJob, { title: string; blurb: string }> = {
  bucket_build: {
    title: 'Rebuild summaries',
    blurb: 'Folds readings into the summary tiers your lists configure. Deletes nothing.',
  },
  data_sweep: {
    title: 'Delete old readings',
    blurb: 'Removes raw readings, frames, commands and events past their window.',
  },
  bucket_delete: {
    title: 'Delete old summaries',
    blurb: 'Removes summary rows past the window their own tier sets.',
  },
  orphan_sweep: {
    title: 'Clean up removed tiers',
    blurb:
      'Removes summaries for a size no longer in any tier list — runs after someone edits one.',
  },
};

/**
 * An instant as wall-clock in the schedule's OWN zone.
 *
 * A row that says "Every day at 03:00 (UTC)" beside "Next Sep 8, 06:00" is stating one schedule in
 * two clocks, and reads as a contradiction — the browser renders an ISO instant in the viewer's
 * zone, which is not the zone the schedule was written in. Formatting here means every time on the
 * row belongs to the same clock as the sentence above it.
 */
function inZone(at: Date | null, timeZone: string): string | null {
  if (at === null) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

/** The floor a job's schedule is held to. Build is cheap; the other three delete. */
function floorMsFor(job: RetentionJob): number {
  return job === 'bucket_build' ? MIN_INTERVAL_MS : MIN_SWEEP_MS;
}

async function lastRunPerJob(): Promise<Map<string, Date>> {
  const rows = await db.retentionRun.groupBy({
    by: ['job'],
    where: { scope_user_id: null, status: { in: TERMINAL }, finished_at: { not: null } },
    _max: { finished_at: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) if (r._max.finished_at) out.set(r.job, r._max.finished_at);
  // A `full` pass did every job, so it counts for all of them.
  const full = out.get('full');
  if (full) {
    for (const job of RETENTION_JOBS) {
      const own = out.get(MODE_OF[job]);
      if (!own || own < full) out.set(MODE_OF[job], full);
    }
  }
  return out;
}

/** The derived build cadence — F18.17's rule, unchanged, and still the default. */
async function derivedCadence() {
  const [policy, user, blueprint, device, action, buckets] = await Promise.all([
    db.retentionPolicyTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
    db.userRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
    db.blueprintRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
    db.deviceRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
    db.actionRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
    db.retentionBucket.findMany({ select: { code: true, seconds: true, label: true } }),
  ]);
  const catalog = new Map(buckets.map((b) => [b.code, { seconds: b.seconds }]));
  const codes = [...policy, ...user, ...blueprint, ...device, ...action].map((r) => r.bucket);
  const finestSeconds = finestBucketSeconds(codes, catalog);
  const intervalSeconds = rollupIntervalSeconds(finestSeconds, Math.ceil(MIN_INTERVAL_MS / 1000));
  const finest = finestSeconds === null ? null : buckets.find((b) => b.seconds === finestSeconds);
  return { intervalSeconds, finest: finest ?? null };
}

/**
 * The shortest raw window configured anywhere, in days — or 0 when everything is kept forever.
 *
 * The other half of the ordering invariant. Raw has to outlive the gap between build passes, so
 * pinning the build schedule needs to know the smallest window it could outrun. `0` is KEEP FOREVER
 * and therefore the largest value, so it is excluded rather than treated as the minimum — getting
 * that backwards would refuse every schedule on a platform that deletes nothing.
 */
async function shortestRawKeepDays(): Promise<number> {
  const [platform, user, device, action, blueprint] = await Promise.all([
    db.retentionPolicyTier.aggregate({
      where: { bucket: 'raw', keep_days: { gt: 0 } },
      _min: { keep_days: true },
    }),
    db.userRetentionTier.aggregate({
      where: { bucket: 'raw', keep_days: { gt: 0 } },
      _min: { keep_days: true },
    }),
    db.deviceRetentionTier.aggregate({
      where: { bucket: 'raw', keep_days: { gt: 0 } },
      _min: { keep_days: true },
    }),
    db.actionRetentionTier.aggregate({
      where: { bucket: 'raw', keep_days: { gt: 0 } },
      _min: { keep_days: true },
    }),
    db.blueprintRetentionTier.aggregate({
      where: { bucket: 'raw', keep_days: { gt: 0 } },
      _min: { keep_days: true },
    }),
  ]);
  const mins = [platform, user, device, action, blueprint]
    .map((r) => r._min.keep_days)
    .filter((n): n is number => n !== null && n > 0);
  return mins.length === 0 ? 0 : Math.min(...mins);
}

/**
 * The longest gap between build passes, in days — for `assertTierList`'s raw floor.
 *
 * Exported because the tier-writing path needs the same number: either write can make the pair
 * unsafe, so both are checked against the same figure.
 */
export async function buildGapDays(now: Date = new Date()): Promise<number> {
  const row = await db.retentionSchedule.findUnique({ where: { job: 'bucket_build' } });
  if (!row || !row.enabled) return 0;
  if (row.cron === null) {
    const { intervalSeconds } = await derivedCadence();
    // A derived cadence is at most daily by construction (`rollupIntervalSeconds` returns null at a
    // day or coarser), so it can never be the binding constraint — but a platform with nothing
    // sub-daily configured builds only on the daily pass, which is one day.
    return intervalSeconds === null ? 1 : Math.ceil(intervalSeconds / 86_400);
  }
  try {
    const { max } = occurrenceGaps(parseCron(row.cron), row.timezone, now);
    return Number.isFinite(max) ? Math.ceil(max / 86_400) : 0;
  } catch {
    return 0;
  }
}

export const retentionScheduleService = {
  /**
   * Every job's schedule, plus the derived-cadence figures F18.17 put on the page.
   *
   * `nextRunAt` is computed the same way the worker decides: from the expression for a pinned
   * schedule, from the last completion plus the interval for a derived one.
   */
  async schedule(now: Date = new Date()) {
    const [rows, cadence, last] = await Promise.all([
      db.retentionSchedule.findMany({
        include: { updated_by: { select: { full_name: true, user_name: true, email: true } } },
      }),
      derivedCadence(),
      lastRunPerJob(),
    ]);

    const jobs = RETENTION_JOBS.map((job) => {
      const row = rows.find((r) => r.job === job);
      const cron = row?.cron ?? null;
      const timezone = row?.timezone ?? 'UTC';
      const enabled = row?.enabled ?? true;
      const lastRunAt = last.get(MODE_OF[job]) ?? null;

      let nextRunAt: Date | null = null;
      let label: string;
      if (!enabled) {
        label = 'Switched off';
      } else if (cron === null) {
        // Derived: F18.17's rule. Said in words rather than as an expression, because there is no
        // expression to show and the whole point is that it moves on its own.
        label =
          cadence.intervalSeconds === null
            ? 'With the daily cleanup — nothing finer than a day is configured'
            : `Every ${describeGap(cadence.intervalSeconds)} — the finest tier configured is ${cadence.finest?.label ?? 'unknown'}`;
        nextRunAt =
          cadence.intervalSeconds === null
            ? null
            : (dueAt(lastRunAt, cadence.intervalSeconds * 1000) ?? now);
      } else {
        label = describeSchedule(cron, timezone);
        try {
          nextRunAt = nextOccurrence(parseCron(cron), timezone, now);
        } catch {
          label = `${cron} — not a schedule this system can read`;
        }
      }

      return {
        job,
        title: JOB_COPY[job].title,
        blurb: JOB_COPY[job].blurb,
        cron,
        timezone,
        enabled,
        derived: cron === null,
        label,
        lastRunAt: lastRunAt?.toISOString() ?? null,
        nextRunAt: nextRunAt?.toISOString() ?? null,
        // Pre-formatted in the schedule's own zone — see `inZone`.
        lastRunLabel: inZone(lastRunAt, timezone),
        nextRunLabel: inZone(nextRunAt, timezone),
        minIntervalSeconds: Math.ceil(floorMsFor(job) / 1000),
        updatedBy:
          row?.updated_by?.full_name ??
          row?.updated_by?.user_name ??
          row?.updated_by?.email ??
          null,
        updatedAt: row?.updated_at?.toISOString() ?? null,
      };
    });

    return {
      jobs,
      // The F18.17 fields, kept so the derived cadence is still stated in its own right.
      rollupIntervalSeconds: cadence.intervalSeconds,
      finestBucket: cadence.finest
        ? { code: cadence.finest.code, label: cadence.finest.label }
        : null,
      fallbackCron: FALLBACK_CRON,
    };
  },

  /**
   * Change one job's schedule.
   *
   * Three refusals, in the order they can be understood: the expression itself, the frequency floor
   * for this particular job, and — for `bucket_build` alone — the ordering invariant that the split
   * can otherwise break silently.
   */
  async setSchedule(
    adminId: number,
    job: string,
    body: Record<string, unknown>,
    now: Date = new Date(),
  ) {
    if (!isRetentionJob(job)) throw badRequest(`"${job}" is not a retention job`);

    const existing = await db.retentionSchedule.findUnique({ where: { job } });
    if (!existing) throw badRequest(`The ${job} schedule row is missing`);

    const rawCron = body['cron'];
    const cron =
      rawCron === null || rawCron === undefined || rawCron === '' ? null : String(rawCron).trim();
    const timezone =
      typeof body['timezone'] === 'string' && body['timezone'] !== ''
        ? body['timezone']
        : existing.timezone;
    const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : existing.enabled;

    // NULL means "derive from the finest configured tier", which only `bucket_build` has anything
    // to derive from. Refusing it here rather than storing it keeps the encoding honest: an unread
    // NULL on `data_sweep` would look like a schedule and behave like nothing.
    if (cron === null && job !== 'bucket_build')
      throw badRequest(
        `Only the summary rebuild can follow the tier lists automatically — ${JOB_COPY[job].title.toLowerCase()} needs a schedule.`,
      );

    if (!isKnownTimeZone(timezone))
      throw badRequest(`"${timezone}" is not a time zone this system knows`);

    if (cron !== null) {
      assertScheduleAdmissible(cron, timezone, Math.ceil(floorMsFor(job) / 1000), now);

      // The ordering invariant, checked here and mirrored by `rawFloorDays` on the tier-writing
      // path. A bucket is built by reading the rows it summarises, so a build that runs less often
      // than raw is kept produces permanently empty buckets for exactly the periods somebody asked
      // to compress rather than lose. Note the DATA SWEEP schedule is irrelevant to this: however
      // often it runs it only deletes rows past their window, so the comparison is build-gap
      // against raw-window and nothing else.
      if (job === 'bucket_build' && enabled) {
        const { max } = occurrenceGaps(parseCron(cron), timezone, now);
        assertBuildKeepsUpWithRaw(max, await shortestRawKeepDays());
      }
    }

    const before = {
      cron: existing.cron,
      timezone: existing.timezone,
      enabled: existing.enabled,
    };
    const after = { cron, timezone, enabled };

    if (before.cron === cron && before.timezone === timezone && before.enabled === enabled)
      return this.schedule(now);

    await db.$transaction(async (tx) => {
      await tx.retentionSchedule.update({
        where: { job },
        data: { cron, timezone, enabled, updated_by_user_id: adminId },
      });
      // In the same transaction as the change it describes (F18.19). An audit trail written
      // best-effort is silently incomplete exactly when something went wrong, which is the only
      // time anybody reads it.
      await retentionActivityService.record(
        {
          action: 'schedule_changed',
          scope: 'platform',
          actorKind: 'admin',
          actorUserId: adminId,
          subjectUserId: null,
          summary: `${JOB_COPY[job].title}: ${describeChange(before, after)}`,
          before,
          after,
        },
        tx,
      );
    });

    return this.schedule(now);
  },
};

/** The change as one line, leading with the switch — it is the one that stops work happening. */
function describeChange(
  before: { cron: string | null; timezone: string; enabled: boolean },
  after: { cron: string | null; timezone: string; enabled: boolean },
): string {
  const parts: string[] = [];
  if (before.enabled !== after.enabled) parts.push(after.enabled ? 'switched on' : 'SWITCHED OFF');
  const said = (c: string | null, tz: string) =>
    c === null ? 'follows the tier lists' : describeSchedule(c, tz);
  if (before.cron !== after.cron || before.timezone !== after.timezone)
    parts.push(`${said(before.cron, before.timezone)} → ${said(after.cron, after.timezone)}`);
  return parts.length > 0 ? parts.join('; ') : 'no change';
}
