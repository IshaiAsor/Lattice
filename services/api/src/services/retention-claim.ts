import { findSweepConflict, sweepLockKey, RETENTION_LOCK_ID } from '@lattice/retention';
import { db } from '../db';

// Claiming the right to sweep, from the API side (F18.13/F18.15).
//
// The API claims rather than just publishing, because a second press has to be REFUSED, not queued,
// and it has to be refused *in the request* — a user who presses Apply four times must not get four
// sweeps, the fourth of which runs against data the first three already trimmed. Answering that
// asynchronously would mean the UI says "started" and the worker silently drops three of them.
//
// automation-worker claims too, for the cron. The RULE they share lives in @lattice/retention
// (`findSweepConflict`); only the INSERT is duplicated, because it is Prisma and each service owns
// its own client.
//
// Two levels, because one is not enough:
//   `lock_key` UNIQUE  stops two runs with the SAME key.
//   advisory lock      stops runs with DIFFERENT keys that still overlap — a global sweep and
//                      user:7's hold different keys yet touch the same rows. Taking
//                      pg_advisory_xact_lock first makes "is anything conflicting?" and the INSERT
//                      one atomic decision, and both services take the same lock id.

const TERMINAL = ['ok', 'failed'];

/** One user-triggered sweep per user per window. Without it Apply is a free DoS on a shared worker. */
const USER_COOLDOWN_MS = Number(process.env['RETENTION_USER_COOLDOWN_MS'] ?? '900000');

/** A run still queued/running after this is presumed abandoned by a killed worker. */
const RUN_STALE_MS = Number(process.env['RETENTION_RUN_STALE_MS'] ?? '21600000');

export interface ClaimRequest {
  trigger: 'admin' | 'user';
  requestedByUserId: number;
  /** NEVER from a request body — the routes pass `req.user!.id` or `null` positionally. */
  scopeUserId: number | null;
}

/**
 * Release runs a killed worker left holding their key.
 *
 * Run before every claim, not only at worker startup: a worker that died mid-sweep would otherwise
 * wedge the feature until it next restarted, and the person pressing Apply is the one who finds out.
 */
async function reapStale(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RUN_STALE_MS);
  await db.retentionRun.updateMany({
    where: { status: { notIn: TERMINAL }, queued_at: { lt: cutoff } },
    data: {
      status: 'failed',
      error: 'abandoned — the worker restarted, or the request dead-lettered',
      finished_at: now,
      lock_key: null,
    },
  });
}

export async function claim(req: ClaimRequest, now: Date = new Date()): Promise<number> {
  await reapStale(now);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RETENTION_LOCK_ID})`;

    const active = await tx.retentionRun.findMany({
      where: { status: { notIn: TERMINAL } },
      select: {
        id: true,
        lock_key: true,
        trigger: true,
        status: true,
        started_at: true,
        queued_at: true,
      },
      orderBy: { queued_at: 'asc' },
    });

    const conflict = findSweepConflict(
      req.scopeUserId,
      active.map((r) => ({
        id: r.id,
        lockKey: r.lock_key,
        trigger: r.trigger,
        status: r.status,
      })),
    );
    if (conflict) {
      const row = active.find((r) => r.id === conflict.id)!;
      const at = (row.started_at ?? row.queued_at).toISOString();
      // 409 naming the trigger and the time — "a sweep is already running" with no detail is the
      // kind of error that gets retried in a loop.
      throw Object.assign(
        new Error(`A ${row.trigger} cleanup started at ${at} is still running.`),
        { statusCode: 409, runId: row.id, trigger: row.trigger, startedAt: at },
      );
    }

    if (req.scopeUserId !== null) {
      const since = new Date(now.getTime() - USER_COOLDOWN_MS);
      const recent = await tx.retentionRun.count({
        where: { scope_user_id: req.scopeUserId, queued_at: { gte: since } },
      });
      if (recent > 0) {
        const minutes = Math.ceil(USER_COOLDOWN_MS / 60_000);
        throw Object.assign(
          new Error(`You can start one cleanup every ${minutes} minutes — try again shortly.`),
          { statusCode: 429 },
        );
      }
    }

    const run = await tx.retentionRun.create({
      data: {
        trigger: req.trigger,
        status: 'queued',
        requested_by_user_id: req.requestedByUserId,
        scope_user_id: req.scopeUserId,
        lock_key: sweepLockKey(req.scopeUserId),
        queued_at: now,
      },
      select: { id: true },
    });
    return run.id;
  });
}
