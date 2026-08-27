import { createLogger } from '@lattice/logger';
import {
  describeTrigger,
  findSweepConflict,
  sweepLockKey,
  RETENTION_LOCK_ID,
  type DataKind,
} from '@lattice/retention';
import { db } from '../db/client';
import { countersForLog, recordActivity, summarizePass } from './retention-activity';
import { env } from '../config/env.config';
import { runRetentionPass, type PassCounters, type PassMode } from './retention.service';
import { currentCadence, decide, lastPlatformRuns } from './retention-cadence';

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

/**
 * Why a run exists.
 *
 * `cron`    the nightly full pass, on its quiet-hour schedule.
 * `catchup` the same full pass, run late because the scheduled one was missed (F18.17). A distinct
 *           value on purpose — "the worker was down at 03:00" is exactly the fact that used to
 *           leave no trace at all, and a run labelled `cron` at 11:40 would just look wrong.
 * `rollup`  an interval pass: builds sub-daily buckets, deletes nothing.
 * `admin`   / `user` — an out-of-band Apply (F18.13/F18.15).
 */
export type Trigger = 'cron' | 'catchup' | 'rollup' | 'admin' | 'user';

/** Everything except an interval pass both rolls up AND prunes. */
function modeOf(trigger: string): PassMode {
  return trigger === 'rollup' ? 'rollup' : 'full';
}

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
      `A ${describeTrigger(active.trigger)} is already running (started ${(active.startedAt ?? active.queuedAt).toISOString()})`,
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
 *
 * `maxAgeMs` is the fuse. Startup passes the SHORT one (`startupGraceMs`), because a process that
 * is starting cannot be executing a run; every other caller uses the conservative six hours. That
 * distinction started mattering with F18.17: a held lock no longer costs one missed night, it stops
 * every interval rollup too, so a crash mid-pass would freeze every chart's right-hand edge until
 * the long fuse burned down.
 */
export async function reapStale(
  now: Date = new Date(),
  maxAgeMs: number = env.retention.runStaleMs,
): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs);
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
  // `catchup` IS the scheduled pass — run late, but nobody else asked for it — so the audit trail
  // says "Nightly sweep" rather than the vaguer "System". Nothing is lost: the run row it links to
  // still carries `catchup`, which is where "and it ran at 11:40 because the worker was down"
  // belongs.
  if (trigger === 'catchup') return 'cron';
  return trigger === 'cron' || trigger === 'admin' || trigger === 'user' ? trigger : 'system';
}

export async function execute(
  runId: number,
  now: Date = new Date(),
  lookbackMs?: number,
): Promise<void> {
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
  const mode = modeOf(row.trigger);
  try {
    const counters = await runRetentionPass({
      now,
      scopeUserId: row.scope_user_id,
      onPhase: (phase) => setPhase(runId, phase),
      mode,
      lookbackMs,
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
    // An interval pass deletes nothing, so it writes no audit entry. `retention_activity` is the
    // trail for irreversible and configuration changes; ninety-six "summarised 12 buckets, removed
    // 0 rows" entries a day would bury the entries someone actually opens the log to find. The
    // FAILURE path below still records, because a rollup that stopped working is exactly the kind
    // of thing this feature is meant to stop being invisible.
    if (mode === 'full') {
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
    }
    log[mode === 'full' ? 'info' : 'debug'](
      { runId, trigger: row.trigger, ms: Date.now() - started },
      'retention run complete',
    );
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
 * Claim globally and run, or give up quietly if something else holds the lock.
 *
 * A loser logs and skips rather than queuing — every window is computed from `now` rather than from
 * a cursor, so the next pass does whatever this one would have.
 */
async function sweepAsPlatform(
  trigger: Trigger,
  now: Date,
  lookbackMs: number | undefined,
  onBusy: (activeId: number) => void,
): Promise<void> {
  try {
    const runId = await claim({ trigger, requestedByUserId: null, scopeUserId: null }, now);
    await execute(runId, now, lookbackMs);
  } catch (err) {
    if (err instanceof SweepInFlightError) {
      onBusy(err.active.id);
      return;
    }
    log.error({ err, trigger }, 'platform retention pass failed — will retry on the next tick');
  }
}

/** The nightly cron: a full pass, rollup then prune, on its quiet-hour schedule. */
export async function runNightlySweep(now: Date = new Date()): Promise<void> {
  await sweepAsPlatform('cron', now, undefined, (activeId) =>
    log.warn({ active: activeId }, 'a sweep is already in flight — skipping tonight'),
  );
}

/**
 * The minute heartbeat behind F18.17.
 *
 * Two things a cron string cannot do, both answered by comparing `now` against `retention_runs`:
 *
 *   AN INTERVAL ROLLUP, at the cadence the tier lists imply. A `15m` bucket built once a night does
 *   not exist for up to 24 hours after its window closes, which a chart draws as a gap at its
 *   right-hand edge — not as "not folded yet", but as "the device was off". Adding the tier changes
 *   the cadence here on the next tick, with no redeploy anywhere.
 *
 *   A CATCH-UP, when the nightly pass was missed entirely. node-cron has no catch-up: a worker
 *   restarting at 03:00, an evicted pod, or a laptop dev stack asleep skips the night silently.
 *   Asking "how long since the last full pass finished?" needs no memory of missed occurrences and
 *   survives a restart, because the answer is in the database rather than in the scheduler.
 *
 * Runs at startup as well as on the tick — a worker that comes back at 11:40 having missed 03:00
 * should not have to be lucky about its restart time.
 */
export async function runCadenceTick(now: Date = new Date()): Promise<void> {
  const [cadence, last] = await Promise.all([currentCadence(), lastPlatformRuns()]);
  const due = decide(cadence, last, now);
  if (due === null) return;

  if (due.kind === 'full') {
    log.warn({ reason: due.reason }, 'retention catch-up pass — the scheduled one was missed');
    await sweepAsPlatform('catchup', now, undefined, (activeId) =>
      log.info({ active: activeId }, 'catch-up deferred — a sweep is already in flight'),
    );
    return;
  }

  log.debug(
    { finest: cadence.finestBucket, everyMs: cadence.intervalMs, lookbackMs: due.lookbackMs },
    'interval rollup due',
  );
  await sweepAsPlatform('rollup', now, due.lookbackMs, (activeId) =>
    log.debug({ active: activeId }, 'interval rollup deferred — a sweep is already in flight'),
  );
}
