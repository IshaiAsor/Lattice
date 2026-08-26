// Aggregation: raw readings folded into a bucket, and a bucket folded into a coarser one.
//
// The second half is what makes an N-tier chain possible. Phase 1 built `hour` and `day` both
// directly from raw, which is affordable for two tiers and ruinous for five — a `1w` tier built
// from raw reads a week of 10-second readings per action per night. Built from `1d` it reads seven
// rows.

/**
 * A scalar reading folded into its bucket's running totals.
 *
 * `sensor_history.value` is TEXT and is under no obligation to be numeric — a switch's history is
 * "on"/"off". Those still deserve a bucket (how many readings, how many faults, what it ended on),
 * so the numeric aggregates are kept separate from the count of rows rather than forcing a NaN
 * through min/max/avg.
 */
export interface Bucket {
  sample_count: number;
  numeric_count: number;
  error_count: number;
  min_value: number | null;
  max_value: number | null;
  sum: number;
  last_value: string | null;
}

export function emptyBucket(): Bucket {
  return {
    sample_count: 0,
    numeric_count: 0,
    error_count: 0,
    min_value: null,
    max_value: null,
    sum: 0,
    last_value: null,
  };
}

/** Rows must arrive in ascending `recorded_at` for `last_value` to mean what it says. */
export function foldReading(b: Bucket, value: string | null, isError: boolean): Bucket {
  b.sample_count += 1;
  if (isError) {
    b.error_count += 1;
    // A fault carries no reading — counting it as a sample but not a value is the distinction the
    // chart draws as a marker rather than a dip to zero.
    return b;
  }
  if (value === null) return b;
  b.last_value = value.slice(0, 255);
  const n = Number(value);
  // Number('') is 0 and Number(' ') is 0, which would quietly turn an empty reading into a real
  // data point; requiring non-empty text keeps the average honest.
  if (value.trim() !== '' && Number.isFinite(n)) {
    b.numeric_count += 1;
    b.sum += n;
    b.min_value = b.min_value === null ? n : Math.min(b.min_value, n);
    b.max_value = b.max_value === null ? n : Math.max(b.max_value, n);
  }
  return b;
}

/** One already-written `sensor_rollup` row, as the fold reads it back. */
export interface RollupRow {
  sample_count: number;
  numeric_count: number;
  error_count: number;
  min_value: number | null;
  max_value: number | null;
  avg_value: number | null;
  last_value: string | null;
}

/**
 * A finer bucket folded into the coarser one above it.
 *
 * The whole point is `avg_value * numeric_count`. A day built from 24 hourly averages by averaging
 * those averages is wrong whenever the hours were unevenly sampled — an hour with two readings
 * would count as much as an hour with three hundred. Re-weighting by the count each average came
 * from reconstructs the sum exactly, so a `1d` bucket equals what folding the raw rows would have
 * produced.
 *
 * Rows must arrive in ascending `bucket_start`, for the same reason `foldReading` needs ascending
 * `recorded_at`: `last_value` is positional, not aggregate.
 */
export function foldRollup(b: Bucket, r: RollupRow): Bucket {
  b.sample_count += r.sample_count;
  b.error_count += r.error_count;
  // A child with no numeric readings still contributes its sample and error counts — it just has no
  // average to weight. Guarding on the count rather than on `avg_value` alone keeps a stored NULL
  // average and a stored zero-count row from being read as "0".
  if (r.numeric_count > 0 && r.avg_value !== null) {
    b.numeric_count += r.numeric_count;
    b.sum += r.avg_value * r.numeric_count;
    if (r.min_value !== null)
      b.min_value = b.min_value === null ? r.min_value : Math.min(b.min_value, r.min_value);
    if (r.max_value !== null)
      b.max_value = b.max_value === null ? r.max_value : Math.max(b.max_value, r.max_value);
  }
  if (r.last_value !== null) b.last_value = r.last_value;
  return b;
}

/** The average, or null when nothing in the bucket parsed as a number. */
export function bucketAvg(b: Bucket): number | null {
  return b.numeric_count === 0 ? null : b.sum / b.numeric_count;
}
