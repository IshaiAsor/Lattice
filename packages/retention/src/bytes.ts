// What a row of history costs on disk, per table.
//
// Every figure the retention feature reports in BYTES comes from here, with exactly one exception:
// `camera_frame_history.byte_size` is recorded at write time, so frames are MEASURED. Everything
// else is an estimate, and the UI labels it as one rather than presenting it as a measurement —
// measuring the rest would mean `pg_total_relation_size` per user, which is not a thing Postgres
// can do.
//
// They live in the package because two services quote them at the user: `api` for the storage
// panel and the per-bucket figures on a tier row (F18.22), and automation-worker for "bytes
// reclaimed" on a sweep. Those two numbers describe the same rows, and a person reading "4.2 MB
// stored" then "reclaimed 1.1 MB" is entitled to assume they are in the same units. They were
// duplicated in both services until F18.22 needed three more.
//
// Each is the column widths plus Postgres's ~24-byte row header, rounded. They are deliberately
// round: precision here would be false, since the real cost depends on fill factor, alignment
// padding, TOAST and index overhead none of which is counted.

/** `sensor_history` — an action id, a short text value, a unit, an error flag, a timestamp. */
export const READING_BYTES = 48;

/** `device_commands` — the widest of them: payload, source, status, two timestamps, ids. */
export const COMMAND_BYTES = 180;

/** `device_events` — a kind, an optional detail, a timestamp. */
export const EVENT_BYTES = 120;

/**
 * `sensor_rollup` — wider than the reading it summarises: three counts, four aggregates, a bucket
 * code and a bucket start.
 *
 * Worth knowing when reading a tier list: a `5m` tier costs 288 of these per sensor per day, so a
 * summary is only cheaper than raw once the sensor reports more often than every ~7 minutes. That
 * trade is the whole reason the per-bucket figures exist.
 */
export const ROLLUP_BYTES = 112;

/** `command_rollup_daily` — an action id, a day, a source, a status, a count. */
export const COMMAND_ROLLUP_BYTES = 64;

/** `device_availability_daily` — a device id, a day, two second-counts, a transition count. */
export const AVAILABILITY_BYTES = 56;

/** One bucket's contribution to a kind: `raw` for the source table, a code for each rollup tier. */
export interface UsageBucket {
  rows: number;
  bytes: number;
  /** False only for camera frames, where `byte_size` is recorded at write time. */
  estimated: boolean;
}

/** A kind's totals, with the breakdown they were summed from. */
export interface KindUsage extends UsageBucket {
  /** Keyed by `retention_buckets.code`, always including `raw`. */
  buckets: Record<string, UsageBucket>;
}

/**
 * Total a kind from its buckets — never alongside them.
 *
 * This is the whole of F18.22 in one function. The storage panel was wrong for a release because
 * its per-kind total was computed from the RAW table while the rollup tables sat uncounted beside
 * it: a figure and a breakdown that disagreed, with nothing to make them agree. Summing the parts
 * means the total cannot omit one, because there is nowhere for an omitted part to hide.
 *
 * `estimated` is true if ANY part is estimated. A kind whose frames are measured and whose
 * summaries are guessed is not a measurement, and rounding that label up would make the one honest
 * figure in the feature dishonest.
 */
export function sumUsage(buckets: Record<string, UsageBucket>): KindUsage {
  const parts = Object.values(buckets);
  return {
    rows: parts.reduce((n, b) => n + b.rows, 0),
    bytes: parts.reduce((n, b) => n + b.bytes, 0),
    estimated: parts.some((b) => b.estimated),
    buckets,
  };
}
