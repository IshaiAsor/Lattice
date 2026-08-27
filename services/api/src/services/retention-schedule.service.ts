import {
  MIN_ROLLUP_INTERVAL_SECONDS,
  dueAt,
  finestBucketSeconds,
  rollupIntervalSeconds,
} from '@lattice/retention';
import { db } from '../db';

// What the retention schedule currently IS, for the admin page (F18.17).
//
// The cadence became derived rather than configured: the rollup half runs on an interval taken from
// the finest bucket anyone has configured, so **adding a `15m` tier changes it with no redeploy**.
// Which is excellent, and completely invisible — an admin who adds that tier has no way to tell the
// cadence moved, and the row's whole complaint was about a schedule nobody could see being wrong
// for months.
//
// So this reads the same inputs the worker's tick reads and applies the same pure functions from
// `@lattice/retention` to them. The QUERY is deliberately duplicated (the worker has its own Prisma
// client and its own connection); the ARITHMETIC is not, because a page that states a cadence
// different from the one being enforced is worse than a page that states nothing.

/** Same default as the worker's `RETENTION_ROLLUP_MIN_INTERVAL_MS`, read the same way. */
const MIN_INTERVAL_MS = Number(
  process.env['RETENTION_ROLLUP_MIN_INTERVAL_MS'] ?? String(MIN_ROLLUP_INTERVAL_SECONDS * 1000),
);

/** Same default as the worker's `RETENTION_MAX_PASS_AGE_MS`: 25h. */
const MAX_PASS_AGE_MS = Number(process.env['RETENTION_MAX_PASS_AGE_MS'] ?? '90000000');

const TERMINAL = ['ok', 'failed'];

export const retentionScheduleService = {
  async schedule() {
    const [policy, user, blueprint, device, action, buckets, lastAny, lastFull] = await Promise.all(
      [
        db.retentionPolicyTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
        db.userRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
        db.blueprintRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
        db.deviceRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
        db.actionRetentionTier.findMany({ distinct: ['bucket'], select: { bucket: true } }),
        db.retentionBucket.findMany({ select: { code: true, seconds: true, label: true } }),
        db.retentionRun.findFirst({
          where: { scope_user_id: null, status: { in: TERMINAL }, finished_at: { not: null } },
          orderBy: { finished_at: 'desc' },
          select: { finished_at: true, trigger: true },
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
          select: { finished_at: true, trigger: true },
        }),
      ],
    );

    const catalog = new Map(buckets.map((b) => [b.code, { seconds: b.seconds }]));
    const codes = [...policy, ...user, ...blueprint, ...device, ...action].map((r) => r.bucket);
    const finestSeconds = finestBucketSeconds(codes, catalog);
    const intervalSeconds = rollupIntervalSeconds(finestSeconds, Math.ceil(MIN_INTERVAL_MS / 1000));
    const finest = finestSeconds === null ? null : buckets.find((b) => b.seconds === finestSeconds);

    const lastRollupAt = lastAny?.finished_at ?? null;
    const lastFullAt = lastFull?.finished_at ?? null;

    return {
      // Null means nothing sub-daily is configured, so the nightly pass is the whole schedule.
      rollupIntervalSeconds: intervalSeconds,
      finestBucket: finest ? { code: finest.code, label: finest.label } : null,
      lastRollupAt: lastRollupAt?.toISOString() ?? null,
      lastFullAt: lastFullAt?.toISOString() ?? null,
      nextRollupDueAt:
        intervalSeconds === null
          ? null
          : (dueAt(lastRollupAt, intervalSeconds * 1000)?.toISOString() ?? null),
      // The worker runs a catch-up pass rather than skipping the night; this says whether one is
      // owed right now, which is the visible form of "the pass was missed".
      fullOverdue: lastFullAt === null || Date.now() - lastFullAt.getTime() >= MAX_PASS_AGE_MS,
    };
  },
};
