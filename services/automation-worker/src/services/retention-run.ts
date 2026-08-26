import { createLogger } from '@lattice/logger';
import {
  findSweepConflict,
  sweepLockKey,
  RETENTION_LOCK_ID,
  type DataKind,
} from '@lattice/retention';
import { db } from '../db/client';
import { countersForLog, recordActivity, summarizePass } from './retention-activity';
import { env } from '../config/env.config';
import { runRetentionPass, type PassCounters } from './retention.service';

const log = createLogger('automation-worker:retention-run');

// Run lifecycle and the two-level lock (F18.13–F18.15).
//
// Two sweeps overlapping on the same rows is not merely wasteful — both are issuing bounded DELETEs
// against the same tables, and the second one's budget is spent re-scanning rows the first is
// already removing. Worse, the job history would show two runs each claiming to have deleted the
// same rows.
//
// The lock has two levels because one is not enough:
//
//   `lock_key` UNIQUE  stops two runs with the SAME key. 'global' for a platform sweep, 'user:<id>'
//                      for a user sweep, NULL once terminal. Postgres's NULL-distinct rule is a
//                      documented trap everywhere else in this schema; here it is exactly the
//                      feature — any number of finished rows carry NULL.
//   advisory lock      stops runs with DIFFERENT keys that still overlap. A global sweep and
//                      user:7's sweep hold different keys and would both be admitted, yet they
//                      touch the same rows. Wrapping the whole claim in pg_advisory_xact_lock makes
//                      "is anything conflicting active?" and the INSERT one atomic decision.
//
// Two DIFFERENT users' sweeps run concurrently on purpose: their rows are disjoint and
// ownership-scoped, and serialising them would make one user's Apply wait on a stranger's.

export type Trigger = 'cron' | 'admin' | 'user';

export interface ClaimRequest {
  trigger: Trigger;
  requestedByUserId: number | null;
  /** Non-null = a user-scoped sweep. NEVER taken from a request body — see the routes. */
  scopeUserId: number | null;
}

export interface ActiveRun {
  id: number;
  trigger: string;
  status: string;
  startedAt: Date | null;
  queuedAt: Date;
  requestedByUserId: number | null;
}

export class SweepInFlightError extends Error {
  statusCode = 409;
  constructor(public readonly active: ActiveRun) {
    super(
      `A ${active.trigger} sweep is already running (started ${(active.startedAt ?? active.queuedAt).toISOString()})`,
    );
  }
}

const TERMINAL = ['ok', 'failed'];

/**
 * Release runs abandoned by a killed worker.
 *
 * A process that dies mid-sweep leaves its row `running` and its `lock_key` held, which would wedge
 * the feature permanently — nobody could ever claim again. Run at startup AND before every claim.
 *
 * This also covers the dead-letter case: every static queue is asserted with `x-message-ttl:
 * 300000`, so an Apply published while this worker is down dead-letters after five minutes. The
 * reaper turns that into a *failed run with a readable error* rather than a request that silently
 * vanished.
 */
export async function reapStale(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.retention.runStaleMs);
  const { count } = await db.retentionRun.updateMany({
    where: { status: { notIn: TERMINAL }, queued_at: { lt: cutoff } },
    data: {
      status: 'failed',
      error: 'abandoned — the worker restarted, or the request dead-lettered',
      finished_at: now,
      lock_key: null,
    },
  });
  if (count > 0) log.warn({ count }, 'reaped abandoned retention runs');
  return count;
}

/**
 * Claim the right to sweep, or throw 409 naming what is already running.
 *
 * A second press is **refused, not queued**: queuing would mean a user pressing Apply four times
 * gets four sweeps, and the fourth one runs against data the first three already trimmed.
 */
export async function claim(req: ClaimRequest, now: Date = new Date()): Promise<number> {
  await reapStale(now);
  const lockKey = sweepLockKey(req.scopeUserId);

  return db.$transaction(async (tx) => {
    // Everything below is inside this advisory lock, so no two claims can interleave their
    // "is anything active?" check with each other's INSERT. Released when the transaction ends,
    // whether it commits or rolls back.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RETENTION_LOCK_ID})`;

    const active = await tx.retentionRun.findMany({
      where: { status: { notIn: TERMINAL } },
      select: {
        id: true,
        trigger: true,
        status: true,
        started_at: true,
        queued_at: true,
        requested_by_user_id: true,
        lock_key: true,
        scope_user_id: true,
      },
      orderBy: { queued_at: 'asc' },
    });

    // The rule itself lives in @lattice/retention, shared with the API's claim: two copies of
    // "does this conflict?" is two chances to disagree about whether a user sweep may run during
    // the platform pass, and the answer decides whether two processes issue overlapping DELETEs.
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
      throw new SweepInFlightError({
        id: row.id,
        trigger: row.trigger,
        status: row.status,
        startedAt: row.started_at,
        queuedAt: row.queued_at,
        requestedByUserId: row.requested_by_user_id,
      });
    }

    // Rate limit, user sweeps only. Without it "Apply" is a free denial-of-service on a worker
    // every other user shares.
    if (req.scopeUserId !== null) {
      const since = new Date(now.getTime() - env.retention.userSweepCooldownMs);
      const recent = await tx.retentionRun.count({
        where: { scope_user_id: req.scopeUserId, queued_at: { gte: since } },
      });
      if (recent > 0) {
        const minutes = Math.ceil(env.retention.userSweepCooldownMs / 60_000);
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
        lock_key: lockKey,
        queued_at: now,
      },
      select: { id: true },
    });
    return run.id;
  });
}

/**
 * Take a queued run and start it, or return null if someone else already did.
 *
 * A compare-and-set rather than a read-then-write: the cron and the queue consumer can both reach
 * a run, and `updateMany` returning 0 rows is the whole handshake.
 */
async function start(runId: number, now: Date): Promise<boolean> {
  const { count } = await db.retentionRun.updateMany({
    where: { id: runId, status: 'queued' },
    data: { status: 'running', started_at: now },
  });
  return count === 1;
}

async function setPhase(runId: number, phase: string): Promise<void> {
  await db.retentionRun.update({ where: { id: runId }, data: { phase } });
}

async function recordCounters(runId: number, counters: PassCounters): Promise<void> {
  for (const [kind, c] of Object.entries(counters) as [DataKind, PassCounters[DataKind]][]) {
    await db.retentionRunKind.upsert({
      where: { run_id_data_kind: { run_id: runId, data_kind: kind } },
      create: {
        run_id: runId,
        data_kind: kind,
        buckets_written: c.bucketsWritten,
        rows_deleted: c.rowsDeleted,
        bytes_reclaimed: c.bytesReclaimed,
        bytes_estimated: c.bytesEstimated,
      },
      update: {
        buckets_written: c.bucketsWritten,
        rows_deleted: c.rowsDeleted,
        bytes_reclaimed: c.bytesReclaimed,
        bytes_estimated: c.bytesEstimated,
      },
    });
  }
}

/**
 * Run a claimed sweep to completion, whatever happens.
 *
 * `finish` is in a `finally` and always clears `lock_key`. A run that throws and keeps its key is
 * indistinguishable from one still working, and nothing would ever claim again.
 */
/**
 * `retention_runs.trigger` is a VarChar the database will accept anything into; the audit column is
 * a closed set. Narrowing it here — rather than casting at the two call sites — means an unexpected
 * value lands as `system` and is visible, instead of writing a trigger name no reader expects.
 */
function actorKindOf(trigger: string): 'user' | 'admin' | 'cron' | 'system' {
  return trigger === 'cron' || trigger === 'admin' || trigger === 'user' ? trigger : 'system';
}

export async function execute(runId: number, now: Date = new Date()): Promise<void> {
  if (!(await start(runId, now))) {
    log.info({ runId }, 'retention run already taken — nothing to do');
    return;
  }

  const row = await db.retentionRun.findUniqueOrThrow({
    where: { id: runId },
    // THE SCOPE COMES FROM HERE. The queue message named the run; it did not get to say whose data
    // this sweep touches.
    select: { scope_user_id: true, trigger: true, requested_by_user_id: true },
  });

  const started = Date.now();
  try {
    const counters = await runRetentionPass({
      now,
      scopeUserId: row.scope_user_id,
      onPhase: (phase) => setPhase(runId, phase),
    });
    await recordCounters(runId, counters);
    await db.retentionRun.update({
      where: { id: runId },
      data: {
        status: 'ok',
        phase: null,
        finished_at: new Date(),
        duration_ms: Date.now() - started,
        lock_key: null,
      },
    });
    await recordActivity({
      action: 'sweep_finished',
      scope: row.scope_user_id === null ? 'platform' : 'user',
      actorKind: actorKindOf(row.trigger),
      actorUserId: row.requested_by_user_id,
      subjectUserId: row.scope_user_id,
      summary: summarizePass(counters),
      after: countersForLog(counters),
      runId,
    });
    log.info({ runId, trigger: row.trigger, ms: Date.now() - started }, 'retention run complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.retentionRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        finished_at: new Date(),
        duration_ms: Date.now() - started,
        error: message.slice(0, 2000),
        lock_key: null,
      },
    });
    await recordActivity({
      action: 'sweep_failed',
      scope: row.scope_user_id === null ? 'platform' : 'user',
      actorKind: actorKindOf(row.trigger),
      actorUserId: row.requested_by_user_id,
      subjectUserId: row.scope_user_id,
      summary: message.slice(0, 400),
      runId,
    });
    log.error({ err, runId }, 'retention run failed');
    // Re-thrown so the consumer nacks to the DLQ, per repo convention. The row already carries the
    // readable error either way, so the failure is visible in the UI even if nobody reads the DLQ.
    throw err;
  }
}

/**
 * The nightly cron: claim globally, then run.
 *
 * A losing cron logs and skips the night rather than queuing — tomorrow's pass picks up whatever
 * this one would have done, because every window is computed from `now` rather than from a cursor.
 */
export async function runNightlySweep(now: Date = new Date()): Promise<void> {
  try {
    const runId = await claim({ trigger: 'cron', requestedByUserId: null, scopeUserId: null }, now);
    await execute(runId, now);
  } catch (err) {
    if (err instanceof SweepInFlightError) {
      log.warn({ active: err.active.id }, 'a sweep is already in flight — skipping tonight');
      return;
    }
    log.error({ err }, 'nightly retention sweep failed — will retry on the next schedule');
  }
}
