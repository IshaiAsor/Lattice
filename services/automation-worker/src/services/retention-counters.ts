import type { DataKind } from '@lattice/retention';

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

export const READING_BYTES = 48n;
export const COMMAND_BYTES = 180n;
export const EVENT_BYTES = 120n;

export interface PassOptions {
  now?: Date;
  /** Non-null restricts the whole pass to one user's rows (F18.15). */
  scopeUserId?: number | null;
  /** Progress hook — writes the run row's `phase` column. */
  onPhase?: (phase: string) => Promise<void> | void;
}
