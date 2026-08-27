// Unit: how often the pass runs, and whether it is late (@lattice/retention) — F18.17.
//
// Phase 2 made every retention DECISION data — tier sizes, counts, windows, ceilings — and left the
// one thing that turned out to matter most frozen: `RETENTION_CRON` at 03:00, overridden nowhere.
// A nightly pass was correct while the finest tier was hard-coded to `1h` and the chart read raw for
// anything recent. It stopped being correct the moment `15m` became configurable: **a bucket built
// once a night does not exist for up to 24 hours after its window closes**, and a chart draws that
// as a gap at its right-hand edge — indistinguishable from "the device was off".
//
// Two independent things are pinned here.
//
// The CADENCE, derived from the finest bucket configured anywhere, which is what makes "adding a
// 15m tier changes the schedule with no redeploy" true.
//
// And OVERDUE-NESS, which is the half that makes a missed pass survivable. node-cron is a
// wall-clock ticker with no catch-up: a worker restarting at 03:00, an evicted pod, or a laptop dev
// stack asleep skips that night silently. Observed live on 2026-08-26 — rollups stopped at the last
// manual sweep while raw ran to the current minute, and neither of the pass's log lines had ever
// been written. Asking "how long since the last one finished?" needs no memory of missed
// occurrences and survives a restart, because the answer is in the database.

import {
  MIN_ROLLUP_INTERVAL_SECONDS,
  ROLLUP_INTERVAL_CEILING_SECONDS,
  catchUpLookbackMs,
  dueAt,
  finestBucketSeconds,
  isDue,
  rollupIntervalSeconds,
} from '../../packages/retention/src';

// The catalog as `retention_buckets` hands it over, plus one custom size that is in no seeded list.
const CATALOG = new Map<string, { seconds: number }>([
  ['raw', { seconds: 0 }],
  ['5m', { seconds: 300 }],
  ['15m', { seconds: 900 }],
  ['30m', { seconds: 1800 }],
  ['90m', { seconds: 5400 }],
  ['1h', { seconds: 3600 }],
  ['1d', { seconds: 86_400 }],
  ['1w', { seconds: 604_800 }],
]);

const MINUTE = 60_000;
const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);

describe('the finest configured bucket', () => {
  it('takes the smallest size any scope has a tier for', () => {
    expect(finestBucketSeconds(['1d', '15m', '1h'], CATALOG)).toBe(900);
  });

  it('finds a custom size the same way as a seeded one', () => {
    // The whole point of the open catalog: a size nobody released still drives the schedule.
    expect(finestBucketSeconds(['1d', '90m'], CATALOG)).toBe(5400);
  });

  it('never treats raw as the finest bucket', () => {
    // Raw has no grid and is never BUILT, only kept. Counting it would derive an interval from a
    // duration of zero.
    expect(finestBucketSeconds(['raw', '1h'], CATALOG)).toBe(3600);
    expect(finestBucketSeconds(['raw'], CATALOG)).toBeNull();
  });

  it('ignores a code the catalog does not know', () => {
    // Cannot happen — every bucket column FKs to the catalog — but guessing a duration for one
    // would be worse than skipping it.
    expect(finestBucketSeconds(['1h', 'nonsense'], CATALOG)).toBe(3600);
  });

  it('returns null when nothing is configured at all', () => {
    expect(finestBucketSeconds([], CATALOG)).toBeNull();
  });
});

describe('the derived rollup interval', () => {
  it('follows the finest bucket', () => {
    expect(rollupIntervalSeconds(900)).toBe(900);
  });

  it('never runs more often than its floor', () => {
    // A 60-second bucket is admissible and someone will make one. Without the floor it turns the
    // sweep into permanent background load on the biggest tables in the system.
    expect(rollupIntervalSeconds(60)).toBe(MIN_ROLLUP_INTERVAL_SECONDS);
  });

  it('honours a floor raised by configuration', () => {
    expect(rollupIntervalSeconds(900, 1800)).toBe(1800);
  });

  it('schedules no interval pass at a day or coarser', () => {
    // A 1d bucket closes at midnight and the nightly pass builds it hours later; an interval
    // ticker would exist only to discover it has nothing to do.
    expect(rollupIntervalSeconds(ROLLUP_INTERVAL_CEILING_SECONDS)).toBeNull();
    expect(rollupIntervalSeconds(604_800)).toBeNull();
  });

  it('schedules no interval pass when nothing is rolled up', () => {
    expect(rollupIntervalSeconds(null)).toBeNull();
  });
});

describe('whether a pass is overdue', () => {
  const now = at('2026-08-27T12:00:00Z');

  it('treats a pass that has never run as due', () => {
    expect(isDue(null, HOUR, now)).toBe(true);
  });

  it('is not due inside its own interval', () => {
    expect(isDue(at('2026-08-27T11:50:00Z'), 15 * MINUTE, now)).toBe(false);
  });

  it('is due the moment the interval has elapsed', () => {
    expect(isDue(at('2026-08-27T11:45:00Z'), 15 * MINUTE, now)).toBe(true);
  });

  it('is due after a worker was down through the scheduled hour', () => {
    // The 2026-08-26 case: the pod was not running at 03:00, node-cron never fired, and nothing
    // anywhere recorded that the night had been skipped. 25h of slack keeps a healthy daily cron
    // out of a photo finish with its own safety net.
    expect(isDue(at('2026-08-26T03:00:00Z'), 25 * HOUR, now)).toBe(true);
    expect(isDue(at('2026-08-27T03:00:00Z'), 25 * HOUR, now)).toBe(false);
  });

  it('names the next due time from the last completion, not from a fixed grid', () => {
    expect(dueAt(at('2026-08-27T11:47:30Z'), 15 * MINUTE)).toEqual(at('2026-08-27T12:02:30Z'));
    expect(dueAt(null, 15 * MINUTE)).toBeNull();
  });
});

describe('how far back an interval pass reads', () => {
  const now = at('2026-08-27T12:00:00Z');
  const MAX = 3 * 24 * HOUR; // RETENTION_LOOKBACK_DAYS

  it('reads only the gap since the last pass', () => {
    // The nightly figure is three days of raw per action. Correct once a night; 96× the read
    // volume every fifteen minutes.
    expect(catchUpLookbackMs(at('2026-08-27T11:00:00Z'), now, 15 * MINUTE, MAX)).toBe(HOUR);
  });

  it('always reaches back two intervals, so the bucket that just closed is rebuilt', () => {
    // A pass running exactly on time has a gap of one interval, and the bucket it exists to build
    // lies entirely in the interval BEFORE that. One interval of lookback steps over it.
    expect(catchUpLookbackMs(at('2026-08-27T11:45:00Z'), now, 15 * MINUTE, MAX)).toBe(30 * MINUTE);
  });

  it('caps a long outage rather than reading everything at once', () => {
    // A worker down for a week must not come back and read a week of raw in one pass. Successive
    // passes walk backwards instead — every upsert is idempotent, so it costs only time.
    expect(catchUpLookbackMs(at('2026-08-20T12:00:00Z'), now, 15 * MINUTE, MAX)).toBe(MAX);
  });

  it('reads the full window when no pass has ever completed', () => {
    expect(catchUpLookbackMs(null, now, 15 * MINUTE, MAX)).toBe(MAX);
  });
});
