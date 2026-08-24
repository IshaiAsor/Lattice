// Pure retention arithmetic — extracted from retention.service.ts so it is unit-testable
// (tests/unit/history.retention-logic.test.ts) without a DB. Everything here is a decision about
// WHICH rows are in scope; the service does the reading and deleting.

/** The four things the platform keeps history of. */
export type DataKind = 'scalar' | 'frame' | 'command' | 'device_event';

/** A platform default plus the ceiling a user may not exceed. `null` ceiling = uncapped. */
export interface PlatformPolicy {
  data_kind: string;
  default_raw_days: number;
  default_hourly_days: number | null;
  default_daily_days: number | null;
  max_raw_days: number | null;
  max_hourly_days: number | null;
  max_daily_days: number | null;
  enabled: boolean;
}

/** One user's override. Absent entirely when they have never chosen anything. */
export interface UserPreference {
  data_kind: string;
  raw_days: number;
  hourly_days: number | null;
  daily_days: number | null;
}

/** What the sweep actually applies for one (user, kind). */
export interface EffectiveWindow {
  raw_days: number;
  hourly_days: number | null;
  daily_days: number | null;
  enabled: boolean;
}

/**
 * Fold one tier's user choice against the default and the ceiling.
 *
 * Two encodings meet here and they are deliberately different:
 *
 *   `days = 0`     KEEP FOREVER. The safe reading for a number that drives DELETEs — a
 *                  misconfigured row keeps too much rather than erasing someone's history.
 *   `ceiling null` UNCAPPED. Not 0, because a ceiling of 0 would otherwise mean "cap everyone at
 *                  forever", which is no cap at all and the opposite of what an admin typing a
 *                  limit intends.
 *
 * So "forever" is the LARGEST value even though it is numerically the smallest, and clamping has
 * to treat it as infinity rather than reaching for Math.min.
 */
export function clampDays(
  chosen: number | null | undefined,
  fallback: number | null,
  ceiling: number | null,
): number | null {
  const value = chosen ?? fallback;
  if (value === null || value === undefined) return null;
  if (ceiling === null) return value;
  // Forever loses to any ceiling: an admin who set a limit meant it to bind the unlimited case
  // most of all.
  if (value === 0) return ceiling;
  return Math.min(value, ceiling);
}

/**
 * The window the nightly sweep applies for one user and one kind.
 *
 * A user with no preference row is not a user with zero retention — it means "follow the
 * platform", which is what makes changing a default move everyone who never customised.
 */
export function resolveRetention(
  policy: PlatformPolicy,
  preference: UserPreference | undefined,
): EffectiveWindow {
  return {
    raw_days: clampDays(preference?.raw_days, policy.default_raw_days, policy.max_raw_days) ?? 0,
    hourly_days: clampDays(
      preference?.hourly_days,
      policy.default_hourly_days,
      policy.max_hourly_days,
    ),
    daily_days: clampDays(preference?.daily_days, policy.default_daily_days, policy.max_daily_days),
    enabled: policy.enabled,
  };
}

/**
 * The cutoff a DELETE should use, or null when nothing should be deleted.
 *
 * Null for both "keep forever" and "this kind is switched off" on purpose: the caller must not be
 * able to accidentally turn either into a Date, and a single null check at the call site is harder
 * to get wrong than remembering which of the two conditions applied.
 */
export function pruneCutoff(days: number | null, enabled: boolean, now: Date): Date | null {
  if (!enabled) return null;
  if (days === null || days <= 0) return null;
  return new Date(now.getTime() - days * 86_400_000);
}

/** Start of the UTC hour containing `d`. */
export function hourStart(d: Date): Date {
  const x = new Date(d);
  x.setUTCMinutes(0, 0, 0);
  return x;
}

/** Midnight UTC of the day containing `d`. */
export function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

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

/** The average, or null when nothing in the bucket parsed as a number. */
export function bucketAvg(b: Bucket): number | null {
  return b.numeric_count === 0 ? null : b.sum / b.numeric_count;
}
