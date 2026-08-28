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
 * Which halves of the pass run (F18.17).
 *
 * `full`   roll up every kind, then prune. The nightly pass, an admin Apply, a user Apply.
 * `rollup` build sub-daily scalar buckets and delete NOTHING. The interval pass — it exists so a
 *          `15m` bucket is minutes stale rather than up to a day, and the one thing it must never
 *          do is bring a DELETE along to that cadence.
 */
export type PassMode = 'full' | 'rollup';

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
