import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';
import { loadTierIndex } from './tier-index';
import { rollUpScalars, rollUpCommands, rollUpAvailability } from './retention-rollup';
import { pruneHistory } from './retention-prune';
import {
  newPassCounters,
  prunes,
  pruneTargetsFor,
  type PassCounters,
  type PassOptions,
} from './retention-counters';

/** A day in milliseconds — the line above which a build pass also rebuilds the day-keyed tables. */
const DAY_MS = 86_400_000;

// The history pass (F18.1 / F18.9 / F18.10 / F18.17 / F18.18): roll every configured tier up, then
// prune whatever is past its window.
//
// It runs in five MODES rather than one shape on one schedule. F18.17 made the first cut — build or
// everything — because building a bucket and deleting a row never shared a cost: building is cheap,
// incremental, idempotent, and somebody is looking at the result right now; deleting is none of
// those. F18.18 finished it, because the destructive half was still three jobs wearing one
// schedule: deleting a million raw readings, deleting a few thousand summary rows, and cleaning up
// after a tier somebody removed this morning are not the same job and do not want the same hour.
//
// `full` remains all of it, in order, and is what an Apply and a catch-up run.
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

/**
 * One pass, doing whichever of the four jobs the mode names.
 *
 * `full` still runs everything in the load-bearing order, so an Apply and a catch-up behave exactly
 * as they always have. The other four modes each do one job, which is what lets each have its own
 * schedule.
 */
export async function runRetentionPass(opts: PassOptions = {}): Promise<PassCounters> {
  const now = opts.now ?? new Date();
  const scopeUserId = opts.scopeUserId ?? null;
  const phase = opts.onPhase ?? (() => undefined);
  const mode = opts.mode ?? 'full';
  const lookbackMs = opts.lookbackMs ?? env.retention.lookbackDays * 86_400_000;
  const started = Date.now();
  const counters = newPassCounters();

  const index = await loadTierIndex(scopeUserId);
  const builds = mode === 'full' || mode === 'build';
  const targets = pruneTargetsFor(mode);

  if (builds) {
    await phase('rollup:scalar');
    counters.scalar.bucketsWritten = await rollUpScalars(index, now, lookbackMs);

    // The two DAY-KEYED rollups do not ride every build pass.
    //
    // `command_rollup_daily` and `device_availability_daily` cannot be made fresher than the day
    // ending, and `rollUpCommands` anchors its window on `dayStart(now)` — so a build running every
    // fifteen minutes would rebuild today's partial day row ninety-six times to reach the same
    // answer, and a narrow lookback would scan fifteen minutes of the previous evening and build
    // nothing at all.
    //
    // F18.17 expressed this as "the interval pass is scalar-only", which was right while the only
    // sub-daily pass was the derived one. Now that an admin can pin the build schedule, the rule has
    // to be about the CADENCE rather than about which code path called: a build pinned to daily
    // should build all three tables, not silently skip two of them.
    if (mode === 'full' || lookbackMs >= DAY_MS) {
      await phase('rollup:command');
      counters.command.bucketsWritten = await rollUpCommands(index, now);
      await phase('rollup:device_event');
      counters.device_event.bucketsWritten = await rollUpAvailability(index, now, scopeUserId);
    }
  }

  if (prunes(mode)) {
    await phase(mode === 'full' ? 'prune' : `prune:${mode}`);
    await pruneHistory(index, now, scopeUserId, counters, targets);
  }

  log[mode === 'full' ? 'info' : 'debug'](
    { ms: Date.now() - started, scopeUserId, mode, lookbackMs },
    'retention pass complete',
  );
  return counters;
}
