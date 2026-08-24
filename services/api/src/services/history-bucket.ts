// Pure query-planning logic for the history API — extracted so it is unit-testable
// (tests/unit/history.bucket-select.test.ts) without a DB or a transport.

/** Which table a series query should read from. */
export type Bucket = 'raw' | 'hour' | 'day';

/** How wide a range has to get before raw rows stop being a sensible answer. */
const RAW_MAX_HOURS = 48;
const HOUR_MAX_DAYS = 60;

/**
 * Pick the granularity for a range.
 *
 * The driver is how many points the client would receive, not how old the data is. A sensor
 * reading every 60s is 1,440 raw rows a day: fine for two days, absurd for two months, and no
 * chart can draw more points than it has pixels. So the range picks the table, and the caller does
 * not get to ask for raw over a year.
 *
 * `requested` lets a caller force a granularity — useful for "show me the actual readings" on a
 * narrow range — but it is a request, not a command: raw is refused for wide ranges because the
 * rows may not exist at all once retention has pruned them.
 */
export function selectBucket(from: Date, to: Date, requested?: string): Bucket {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  const auto: Bucket =
    hours <= RAW_MAX_HOURS ? 'raw' : hours <= HOUR_MAX_DAYS * 24 ? 'hour' : 'day';
  if (requested === 'hour' || requested === 'day') return requested;
  if (requested === 'raw') return hours <= RAW_MAX_HOURS ? 'raw' : auto;
  return auto;
}

/**
 * Clamp a requested range to something answerable, defaulting to the last 7 days.
 *
 * Invalid dates collapse to the default rather than throwing: a bad `?from=` on a dashboard should
 * show the usual week, not a 400 that blanks the page.
 */
export function resolveRange(
  fromRaw: unknown,
  toRaw: unknown,
  now: Date = new Date(),
  defaultDays = 7,
): { from: Date; to: Date } {
  const parse = (v: unknown): Date | null => {
    if (typeof v !== 'string' || v.trim() === '') return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  const to = parse(toRaw) ?? now;
  const from = parse(fromRaw) ?? new Date(to.getTime() - defaultDays * 86_400_000);
  // A reversed range is a caller mistake, not an empty result: swapping is what they meant.
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Clamp a page size the way rules.service.listEvents does — default 50, hard ceiling 200. */
export function clampLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
