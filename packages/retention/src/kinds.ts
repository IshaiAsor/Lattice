// The four things the platform keeps history of, and the one sentinel that is not a duration.
//
// This is the smallest module in the package on purpose: `buckets`, `tiers`, `fold` and `windows`
// all need these two facts, and importing them from each other would make the dependency graph a
// ring rather than a tree.

/** The four things the platform keeps history of. */
export type DataKind = 'scalar' | 'frame' | 'command' | 'device_event';

export const DATA_KINDS: readonly DataKind[] = ['scalar', 'frame', 'command', 'device_event'];

export function isDataKind(value: string): value is DataKind {
  return (DATA_KINDS as readonly string[]).includes(value);
}

/**
 * The raw tier's `seconds`.
 *
 * `raw` is a tier like any other in every way that matters — it has a position, a keep window and a
 * row in the catalog — but it is not a duration: raw rows are written one per reading, not folded
 * into a grid. Zero is the encoding for "no grid", which is why `bucketStart` refuses it rather
 * than dividing by it.
 */
export const RAW_SECONDS = 0;

/** The reserved catalog code for the raw tier. */
export const RAW_BUCKET = 'raw';
