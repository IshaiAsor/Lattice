import { createLogger } from '@lattice/logger';
import { loadTierIndex } from './tier-index';
import { rollUpScalars, rollUpCommands, rollUpAvailability } from './retention-rollup';
import { pruneHistory } from './retention-prune';
import { newPassCounters, type PassCounters, type PassOptions } from './retention-counters';

// The nightly history pass (F18.1 / F18.9 / F18.10): roll every configured tier up, then prune
// whatever is past its window.
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

export type { KindCounters, PassCounters, PassOptions } from './retention-counters';
export { rollUpScalars, rollUpCommands, rollUpAvailability } from './retention-rollup';
export { pruneHistory } from './retention-prune';

/** The whole pass. Roll up, then prune — never the other way round. */
export async function runRetentionPass(opts: PassOptions = {}): Promise<PassCounters> {
  const now = opts.now ?? new Date();
  const scopeUserId = opts.scopeUserId ?? null;
  const phase = opts.onPhase ?? (() => undefined);
  const started = Date.now();
  const counters = newPassCounters();

  const index = await loadTierIndex(scopeUserId);

  await phase('rollup:scalar');
  counters.scalar.bucketsWritten = await rollUpScalars(index, now);
  await phase('rollup:command');
  counters.command.bucketsWritten = await rollUpCommands(index, now);
  await phase('rollup:device_event');
  counters.device_event.bucketsWritten = await rollUpAvailability(index, now, scopeUserId);
  await phase('prune');
  await pruneHistory(index, now, scopeUserId, counters);

  log.info({ ms: Date.now() - started, scopeUserId }, 'retention pass complete');
  return counters;
}
