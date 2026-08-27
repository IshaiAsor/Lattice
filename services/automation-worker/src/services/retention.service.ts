import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';
import { loadTierIndex } from './tier-index';
import { rollUpScalars, rollUpCommands, rollUpAvailability } from './retention-rollup';
import { pruneHistory } from './retention-prune';
import { newPassCounters, type PassCounters, type PassOptions } from './retention-counters';

// The history pass (F18.1 / F18.9 / F18.10 / F18.17): roll every configured tier up, then prune
// whatever is past its window.
//
// Since F18.17 it runs in two MODES rather than one shape on one schedule. `full` is the whole
// thing — the nightly cron, an admin Apply, a user Apply. `rollup` is the interval pass: it builds
// sub-daily scalar buckets at the cadence the finest configured tier implies and deletes nothing at
// all. The two halves stopped sharing a schedule because they never shared a cost: building a
// bucket is cheap, incremental and idempotent, and somebody is looking at the result right now;
// deleting a row is none of those.
//
// Order is load-bearing: ROLL UP FIRST, PRUNE SECOND. A bucket is built by reading the rows it
// summarises, so pruning first would silently produce empty buckets for exactly the periods a user
// asked to compress rather than lose. Everything is idempotent — buckets upsert on their unique
// key — so a re-run, a missed night, or a crash halfway through self-heals on the next pass rather
// than double-counting.
//
// Batched and capped throughout. This shares a process with the 10s rules tick, and a delete over
// millions of rows holding a lock is how a history feature takes down automation.
//
// THE PARTS LIVE BESIDE THIS FILE, which is now only the order:
//   retention-rollup.ts    builds buckets, each tier folded from the next finer one
//   retention-prune.ts     deletes what is past its window, plus the orphan sweep
//   retention-delete.ts    the bounded DELETE both of those need
//   retention-counters.ts  what they all write into
//
// Re-exported below so a caller that wants the pass and its shapes still has one import.

const log = createLogger('automation-worker:retention');

export type { KindCounters, PassCounters, PassOptions, PassMode } from './retention-counters';
export { rollUpScalars, rollUpCommands, rollUpAvailability } from './retention-rollup';
export { pruneHistory } from './retention-prune';

/** The whole pass. Roll up, then prune — never the other way round. */
export async function runRetentionPass(opts: PassOptions = {}): Promise<PassCounters> {
  const now = opts.now ?? new Date();
  const scopeUserId = opts.scopeUserId ?? null;
  const phase = opts.onPhase ?? (() => undefined);
  const mode = opts.mode ?? 'full';
  const lookbackMs = opts.lookbackMs ?? env.retention.lookbackDays * 86_400_000;
  const started = Date.now();
  const counters = newPassCounters();

  const index = await loadTierIndex(scopeUserId);

  await phase('rollup:scalar');
  counters.scalar.bucketsWritten = await rollUpScalars(index, now, lookbackMs);

  // An interval pass stops here (F18.17), and stops here for two separate reasons.
  //
  // It never prunes, because deleting is the half that is neither cheap nor reversible and has no
  // freshness argument behind it — nobody is looking at a row that is about to be gone.
  //
  // And it skips the other two rollups because **their buckets are day-keyed**: `command_rollup_daily`
  // and `device_availability_daily` cannot be made fresher by running more often than the day ends,
  // and `rollUpCommands` in particular anchors its window on `dayStart(now)`, so a fifteen-minute
  // lookback would scan fifteen minutes of the previous evening and build nothing. The interval is
  // derived from the finest SCALAR bucket — the only kind that may have a sub-daily one — so scalar
  // is the only thing it is answering for.
  if (mode === 'rollup') {
    log.debug({ ms: Date.now() - started, lookbackMs }, 'retention rollup pass complete');
    return counters;
  }

  await phase('rollup:command');
  counters.command.bucketsWritten = await rollUpCommands(index, now);
  await phase('rollup:device_event');
  counters.device_event.bucketsWritten = await rollUpAvailability(index, now, scopeUserId);
  await phase('prune');
  await pruneHistory(index, now, scopeUserId, counters);

  log.info({ ms: Date.now() - started, scopeUserId }, 'retention pass complete');
  return counters;
}
