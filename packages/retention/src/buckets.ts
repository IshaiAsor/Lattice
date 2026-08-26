// Bucket arithmetic and the admission rules for a bucket size.
//
// The vocabulary itself is DATA — rows in `retention_buckets`, which any user may add to. Nothing
// here hard-codes a list of codes, and adding `90m` needs no release: flooring is generic over
// `seconds`, so a size the catalog has never seen floors correctly the first time it is used.
//
// What stays in code is only what a row cannot express: the admission rules below, the chain
// divisibility rule in `tiers.ts`, and the per-kind limits at the bottom of this file.

import { RAW_SECONDS, type DataKind } from './kinds';

/**
 * A day, and a week, in seconds.
 *
 * These are NOT bucket sizes — the vocabulary is data, and nothing in this package holds a list of
 * codes. They are the units the *rules* are written in, which is why they survived F18.9:
 *
 *   - `DAY_SECONDS` is what "divides a day evenly, or is a whole number of days" means, and it is
 *     also the per-kind rule for `command`/`device_event`, whose rollup tables are DATE-keyed and
 *     therefore cannot hold a sub-day bucket. Neither is expressible as a catalog row.
 *   - `WEEK_SECONDS` earns much less: it is only used to NAME things — 1 209 600 reads as `2w`
 *     rather than `14d`. Presentation, not vocabulary.
 *
 * Both are module-private. Nothing outside this file uses either, so neither is exported.
 */
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/**
 * The finest bucket the catalog will admit.
 *
 * Below a minute the row count stops being a summary: a 30-second bucket on a 10-second sensor is
 * three readings, which is more rollup rows than the raw rows it replaces.
 */
const MIN_BUCKET_SECONDS = 60;

/**
 * One row of the `retention_buckets` catalog, as the pure code sees it.
 *
 * `anchorOffsetSeconds` shifts the boundary grid. It is `0` for almost everything, because the
 * epoch grid already lands where a human expects — but not for `1w`: flooring on multiples of
 * 604 800 lands on a **Thursday**, since 1 Jan 1970 was one. That row carries 345 600 (four days)
 * to move the grid to Monday.
 */
export interface BucketDef {
  code: string;
  seconds: number;
  label: string;
  anchorOffsetSeconds: number;
}

/** The anchor that moves the weekly grid off the epoch's Thursday and onto Monday. */
export const WEEK_ANCHOR_OFFSET_SECONDS = 4 * DAY_SECONDS;

/**
 * The start of the bucket containing `d`.
 *
 * `floor((epoch − a) / s) * s + a` — correct for **any** fixed duration, which is the whole reason
 * a custom size needs no code. `Math.floor` (not truncation) matters for pre-epoch dates: it floors
 * toward negative infinity, so a 1969 reading lands in the bucket before the epoch rather than the
 * one after it.
 */
export function bucketStart(d: Date, seconds: number, anchorOffsetSeconds = 0): Date {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(
      `bucketStart needs a positive duration, got ${seconds} — raw has no grid to floor onto`,
    );
  const epoch = Math.floor(d.getTime() / 1000);
  const start = Math.floor((epoch - anchorOffsetSeconds) / seconds) * seconds + anchorOffsetSeconds;
  return new Date(start * 1000);
}

/** Start of the UTC hour containing `d` — epoch-multiple flooring of 3600s lands exactly there. */
export function hourStart(d: Date): Date {
  return bucketStart(d, 3_600);
}

/** Midnight UTC of the day containing `d`. */
export function dayStart(d: Date): Date {
  return bucketStart(d, DAY_SECONDS);
}

/**
 * Every divisor of a day that is a legal bucket, ascending.
 *
 * 86 400 = 2^7·3^3·5^2, so there are 96 divisors and enumerating them costs nothing. They are what
 * the refusal messages below suggest, so a rejected size is answered with sizes that work rather
 * than with the rule that rejected it.
 */
function dayDivisors(): number[] {
  const out: number[] = [];
  for (let n = MIN_BUCKET_SECONDS; n <= DAY_SECONDS; n++) {
    if (DAY_SECONDS % n === 0) out.push(n);
  }
  return out;
}

/**
 * A duration as the code a human would type: `90m`, `6h`, `1d`, `1w`.
 *
 * Order is load-bearing — a week is also a whole number of days and of hours, so the coarsest unit
 * has to be tried first or `1w` prints as `168h`.
 */
export function formatSeconds(seconds: number): string {
  if (seconds === RAW_SECONDS) return 'raw';
  if (seconds % WEEK_SECONDS === 0) return `${seconds / WEEK_SECONDS}w`;
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** A bucket that a human would read as a duration — "90 minutes", "6 hours". */
export function describeSeconds(seconds: number): string {
  if (seconds === RAW_SECONDS) return 'raw readings';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds % WEEK_SECONDS === 0) return unit(seconds / WEEK_SECONDS, 'week');
  if (seconds % DAY_SECONDS === 0) return unit(seconds / DAY_SECONDS, 'day');
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, 'hour');
  if (seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/** Is this a size the catalog will accept at all? */
export function isBucketAdmissible(seconds: number): boolean {
  if (!Number.isInteger(seconds) || seconds < MIN_BUCKET_SECONDS) return false;
  // Whole days, or an even division of one. Either way every boundary falls at the same clock time
  // every day, which is what makes a chart's gridlines mean something.
  return seconds % DAY_SECONDS === 0 || DAY_SECONDS % seconds === 0;
}

/**
 * Reject a size the catalog may not hold, naming sizes that would have worked.
 *
 * The rule is not arbitrary: a size that neither divides a day nor is a whole number of days drifts
 * against the clock. 7 hours puts today's boundaries at 00:00, 07:00, 14:00, 21:00 and tomorrow's
 * at 04:00, 11:00, 18:00 — the same bucket means a different part of the day depending on when you
 * look at it, and no chart axis can label that honestly.
 */
export function assertBucketAdmissible(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds <= 0)
    throw badRequest(`A bucket size must be a whole number of seconds, got ${seconds}`);
  if (seconds < MIN_BUCKET_SECONDS)
    throw badRequest(
      `${describeSeconds(seconds)} is finer than the ${describeSeconds(MIN_BUCKET_SECONDS)} ` +
        `minimum — below that a bucket holds fewer readings than it costs to store`,
    );
  if (isBucketAdmissible(seconds)) return;

  const divisors = dayDivisors();
  const below = [...divisors].reverse().find((n) => n < seconds);
  const above = divisors.find((n) => n > seconds);
  const suggestions = [below, above].filter((n): n is number => n !== undefined).map(formatSeconds);
  throw badRequest(
    `${describeSeconds(seconds)} does not divide a day evenly` +
      (suggestions.length > 0 ? ` — try ${suggestions.join(' or ')}` : ''),
  );
}

/**
 * May this kind be rolled up at this size?
 *
 * These are storage facts, not policy — `command_rollup_daily` and `device_availability_daily` are
 * keyed on a `DATE`, so an hourly command bucket has nowhere to be written; and a camera frame is
 * an image, which does not average.
 *
 * Every kind may keep raw rows, so `raw` is allowed everywhere. That is what makes "raw is a tier"
 * work for `frame`, whose tier list is raw and nothing else.
 */
export function allowedForKind(kind: DataKind, seconds: number): boolean {
  if (seconds === RAW_SECONDS) return true;
  switch (kind) {
    case 'scalar':
      return true;
    case 'command':
    case 'device_event':
      return seconds % DAY_SECONDS === 0;
    case 'frame':
      return false;
  }
}

/** Why a bucket is not available for a kind, in words the API can hand to a user. */
export function whyNotAllowedForKind(kind: DataKind, seconds: number): string {
  if (kind === 'frame')
    return 'camera frames are images, and there is no average of two photographs';
  return `${kind} history is stored one row per day, so ${formatSeconds(seconds)} is finer than it can be kept`;
}

export function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}
