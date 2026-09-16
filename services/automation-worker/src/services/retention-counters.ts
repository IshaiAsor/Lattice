import {
  COMMAND_BYTES as COMMAND_BYTES_EST,
  EVENT_BYTES as EVENT_BYTES_EST,
  READING_BYTES as READING_BYTES_EST,
  type DataKind,
} from '@lattice/retention';

// What a retention pass counts, and the per-row constants behind "bytes reclaimed".
//
// Split out of retention.service.ts because all four of its parts need these and none of them owns
// them: the rollup writes `bucketsWritten`, the prune writes `rowsDeleted` and `bytesReclaimed`,
// the pass creates the object, and the run recorder reads it back.

export interface KindCounters {
  bucketsWritten: number;
  rowsDeleted: number;
  bytesReclaimed: bigint;
  bytesEstimated: boolean;
}

export type PassCounters = Record<DataKind, KindCounters>;

const emptyCounters = (): KindCounters => ({
  bucketsWritten: 0,
  rowsDeleted: 0,
  bytesReclaimed: 0n,
  bytesEstimated: true,
});

export function newPassCounters(): PassCounters {
  return {
    scalar: emptyCounters(),
    frame: emptyCounters(),
    command: emptyCounters(),
    device_event: emptyCounters(),
  };
}

// The same per-row estimates the storage panel quotes, from @lattice/retention (F18.22). They were
// duplicated here and in `api` until the panel needed three more, and the two numbers describe the
// same rows: a person reading "4.2 MB stored" then "reclaimed 1.1 MB" is entitled to assume they
// are in the same units. BigInt because a pass counts bytes across millions of rows.
export const READING_BYTES = BigInt(READING_BYTES_EST);
export const COMMAND_BYTES = BigInt(COMMAND_BYTES_EST);
export const EVENT_BYTES = BigInt(EVENT_BYTES_EST);

/**
 * Which parts of the pass run (F18.17, widened by F18.18).
 *
 * F18.17 made this a two-way split — build or everything — because building a bucket and deleting a
 * row never shared a cost. F18.18 finished the job: the destructive half was still three jobs
 * wearing one schedule, and they are not alike either.
 *
 * `full`   everything, in the load-bearing order. An Apply and a catch-up.
 * `build`  write the rollup tables and delete NOTHING. The one thing it must never do is bring a
 *          DELETE along to a fifteen-minute cadence.
 * `sweep`  delete raw rows only — the biggest tables in the system.
 * `delete` delete rollup rows past each tier's own window. Small tables, irreversible.
 * `orphan` delete rollup rows for a bucket size no longer in any tier list. The only one whose
 *          trigger is a person changing their mind rather than a window expiring.
 *
 * A pass in one of the three destructive modes reports counters for that mode alone, which is a
 * quiet correctness win: F18.23 was found because `rowsDeleted` summed raw and rollup deletes into
 * one ambiguous number, and it now cannot.
 */
export type PassMode = 'full' | 'build' | 'sweep' | 'delete' | 'orphan';

/** Which deletes a pass is allowed to issue. Derived from the mode; see `pruneTargetsFor`. */
export interface PruneTargets {
  raw: boolean;
  rollups: boolean;
  orphans: boolean;
}

export function pruneTargetsFor(mode: PassMode): PruneTargets {
  return {
    raw: mode === 'full' || mode === 'sweep',
    rollups: mode === 'full' || mode === 'delete',
    orphans: mode === 'full' || mode === 'orphan',
  };
}

/** Does this mode delete anything at all? `build` is the only one that does not. */
export function prunes(mode: PassMode): boolean {
  const t = pruneTargetsFor(mode);
  return t.raw || t.rollups || t.orphans;
}

export interface PassOptions {
  now?: Date;
  /** Non-null restricts the whole pass to one user's rows (F18.15). */
  scopeUserId?: number | null;
  /** Progress hook — writes the run row's `phase` column. */
  onPhase?: (phase: string) => Promise<void> | void;
  /** Defaults to `full`. */
  mode?: PassMode;
  /**
   * How far back to look for buckets to rebuild. Defaults to `RETENTION_LOOKBACK_DAYS`.
   *
   * An interval pass narrows it to the gap since the last one finished: the nightly figure is
   * three days of raw per action, which is correct once a night and **96× the read volume every
   * fifteen minutes**. Every upsert is idempotent either way, so the two differ only in cost.
   */
  lookbackMs?: number;
}
