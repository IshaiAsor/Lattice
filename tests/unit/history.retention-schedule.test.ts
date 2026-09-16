// Unit: when each retention job runs (@lattice/retention) — F18.18.
//
// `RETENTION_CRON` was the last piece of retention policy that still needed a redeploy, and it was
// covering three jobs that want three different hours: deleting a million raw readings, deleting a
// few thousand summary rows, and cleaning up after a tier somebody removed this morning. Moving the
// schedule into a table is only half of it — the other half is that **the minute tick became the
// scheduler**, so this module is now the single authority on what a valid schedule is and when it
// fires. node-cron never sees these expressions.
//
// Four things are pinned here, and three of them are silent-data-loss bugs if wrong.
//
// The PARSER, whose accepted surface deliberately matches node-cron's so that nothing which ran
// yesterday is refused today.
//
// TIMEZONE arithmetic, because a quiet hour is a local wall-clock concept and the worker container
// runs UTC (no TZ in compose or in the k8s manifests) — which is why '0 0 3 * * *' has in fact been
// firing at 06:00 Jerusalem all along. Both DST directions are covered: a spring-forward wall time
// does not exist and its day must be SKIPPED, and a fall-back one exists twice and must fire ONCE.
//
// The FREQUENCY FLOOR, sampled rather than averaged. `0 0,1 3 * * *` fires twice a day: its average
// gap is twelve hours and its real gap is one minute, so an average would wave through exactly the
// schedule the floor exists to refuse.
//
// And the ORDERING INVARIANT, which is the one thing splitting the pass into four schedules can
// break. A bucket is built by reading the rows it summarises, so raw deleted before a build pass has
// seen it produces permanently empty buckets for the periods someone asked to COMPRESS rather than
// lose. Note what is NOT part of it: the data-sweep schedule. However often a sweep runs it only
// deletes rows past their window, so the comparison is build-gap against raw-window and nothing
// else. It is checked from both sides, because either write can make the pair unsafe.

import {
  assertBuildKeepsUpWithRaw,
  assertScheduleAdmissible,
  describeGap,
  describeJob,
  describeSchedule,
  describeSweep,
  isJobDue,
  isKnownTimeZone,
  isRetentionJob,
  nextOccurrence,
  occurrenceGaps,
  parseCron,
  prevOccurrence,
  rawDaysNeededForGap,
  rawFloorDays,
  RETENTION_JOBS,
} from '../../packages/retention/src';

const TZ = 'Asia/Jerusalem';
const UTC = 'UTC';

/** An instant read as wall-clock in a zone, which is the only way these assertions are readable. */
function wall(d: Date | null, timeZone: string): string {
  if (d === null) return 'none';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** The next `count` firings, as wall-clock strings. */
function series(expr: string, timeZone: string, from: string, count: number): string[] {
  const fields = parseCron(expr);
  const out: string[] = [];
  let cursor = new Date(from);
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(fields, timeZone, cursor);
    if (next === null) break;
    out.push(wall(next, timeZone));
    cursor = next;
  }
  return out;
}

describe('parsing an expression', () => {
  it('accepts the five-field form by assuming a zero seconds field', () => {
    expect(parseCron('0 3 * * *')).toEqual(parseCron('0 0 3 * * *'));
  });

  it('expands a step into the values it admits', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
  });

  it('steps a range from its start, the standard reading', () => {
    // node-cron instead keeps values divisible by the step (3, 6, 9). That is a quirk rather than a
    // contract, nothing can be relying on it — the only expression this platform has ever run is
    // `0 0 3 * * *` — and for `*/n`, the form anyone actually writes, the two agree.
    expect(parseCron('1-10/3 * * * *').minutes).toEqual([1, 4, 7, 10]);
  });

  it('understands month and weekday names', () => {
    expect(parseCron('0 3 * jan,dec *').months).toEqual([1, 12]);
    expect(parseCron('0 3 * * Monday,Sat').daysOfWeek).toEqual([1, 6]);
  });

  it('treats 7 as Sunday, the one alias every cron agrees on', () => {
    expect(parseCron('0 3 * * 7').daysOfWeek).toEqual([0]);
  });

  it('refuses an expression with the wrong number of fields', () => {
    expect(() => parseCron('* * *')).toThrow(/5 or 6 fields/);
  });

  it('refuses a value outside its field, naming the field', () => {
    expect(() => parseCron('0 99 * * *')).toThrow(/hour field must be between 0 and 23/);
  });

  it('refuses a name no field understands', () => {
    expect(() => parseCron('0 3 * * funday')).toThrow(/day of week/);
  });

  it('refuses a zero step rather than looping forever', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/not a step/);
  });
});

describe('projecting occurrences', () => {
  it('reads the hour in the schedule zone, not the host zone', () => {
    // The whole reason the timezone column exists. The worker runs UTC, so without this a Jerusalem
    // admin choosing 03:00 gets 06:00 — which is what has actually been happening.
    const at = nextOccurrence(parseCron('0 0 3 * * *'), TZ, new Date('2026-09-07T00:00:00Z'));
    expect(wall(at, TZ)).toBe('2026-09-08 03:00');
    expect(at!.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  it('finds the most recent firing at or before an instant', () => {
    const at = prevOccurrence(parseCron('0 0 3 * * *'), TZ, new Date('2026-09-07T09:00:00Z'));
    expect(wall(at, TZ)).toBe('2026-09-07 03:00');
  });

  it('skips a day whose wall-clock time the spring-forward jump erased', () => {
    // Jerusalem 2026-03-27: 02:00 becomes 03:00, so 02:30 never happens. 27 March is absent, and
    // the sequence resumes on the 28th rather than firing twice or throwing.
    expect(series('0 30 2 * * *', TZ, '2026-03-25T00:00:00Z', 4)).toEqual([
      '2026-03-25 02:30',
      '2026-03-26 02:30',
      '2026-03-28 02:30',
      '2026-03-29 02:30',
    ]);
  });

  it('fires once, at the earlier instant, when the clocks go back over it', () => {
    // Jerusalem 2026-10-25: 02:00 becomes 01:00, so 01:30 happens twice — at 22:30Z and 23:30Z.
    // One firing, and the earlier of the two: a job that ran at the first 01:30 must not be run
    // again an hour later by the second.
    const days = series('0 30 1 * * *', TZ, '2026-10-23T00:00:00Z', 4);
    expect(days.filter((d) => d.startsWith('2026-10-25'))).toEqual(['2026-10-25 01:30']);

    const at = nextOccurrence(parseCron('0 30 1 * * *'), TZ, new Date('2026-10-24T12:00:00Z'));
    expect(at!.toISOString()).toBe('2026-10-24T22:30:00.000Z');
  });

  it('returns nothing for a date the calendar never reaches', () => {
    expect(nextOccurrence(parseCron('0 0 3 31 2 *'), UTC, new Date('2026-09-07T00:00:00Z'))).toBe(
      null,
    );
  });
});

describe('how often a schedule fires', () => {
  const NOW = new Date('2026-09-07T12:00:00Z');
  const gaps = (expr: string) => occurrenceGaps(parseCron(expr), UTC, NOW);

  it('measures the real gap, not the average one', () => {
    // Twice a day at 03:00 and 03:01. The average is twelve hours; the gap that matters is one
    // minute, and an average would let this through the floor.
    expect(gaps('0 0,1 3 * * *')).toEqual({ min: 60, max: 86_340 });
  });

  it('reports a steady schedule as one gap', () => {
    expect(gaps('0 0 3 * * *')).toEqual({ min: 86_400, max: 86_400 });
    expect(gaps('*/15 * * * *')).toEqual({ min: 900, max: 900 });
  });

  it('treats an expression that can never fire twice as unboundedly rare', () => {
    // Infinity is the safe answer in both directions: it passes the frequency floor and fails the
    // ordering invariant, which is the way round that cannot lose data.
    expect(gaps('0 0 3 31 2 *')).toEqual({ min: Infinity, max: Infinity });
  });
});

describe('refusing a schedule', () => {
  const NOW = new Date('2026-09-07T12:00:00Z');

  it('accepts a daily cleanup against the destructive floor', () => {
    expect(() => assertScheduleAdmissible('0 0 3 * * *', UTC, 3_600, NOW)).not.toThrow();
  });

  it('refuses a schedule that would delete more often than the floor allows', () => {
    expect(() => assertScheduleAdmissible('*/15 * * * *', UTC, 3_600, NOW)).toThrow(
      /every 15 minutes, and the limit is once every 1 hour/,
    );
  });

  it('holds the cheap build job to a lower floor than the destructive ones', () => {
    // The two halves stopped sharing a cadence in F18.17 and do not share a floor either: building
    // is incremental and idempotent, deleting is neither.
    expect(() => assertScheduleAdmissible('*/15 * * * *', UTC, 300, NOW)).not.toThrow();
  });

  it('refuses a time zone the system does not know', () => {
    expect(() => assertScheduleAdmissible('0 0 3 * * *', 'Mars/Olympus', 3_600, NOW)).toThrow(
      /not a time zone/,
    );
    expect(isKnownTimeZone(TZ)).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
  });

  it('refuses an expression that describes a date that never happens', () => {
    expect(() => assertScheduleAdmissible('0 0 3 31 2 *', UTC, 3_600, NOW)).toThrow(
      /never happens/,
    );
  });
});

describe('keeping the build ahead of the sweep', () => {
  it('accepts a daily build against a two-day raw window', () => {
    expect(() => assertBuildKeepsUpWithRaw(86_400, 2)).not.toThrow();
  });

  it('refuses a build too rare to summarise raw before it expires', () => {
    // A weekly build against a two-day raw window loses five days of readings every week, silently.
    expect(() => assertBuildKeepsUpWithRaw(604_800, 2)).toThrow(
      /deleted before they were ever summarised/,
    );
  });

  it('names both numbers in the refusal, and what would work', () => {
    expect(() => assertBuildKeepsUpWithRaw(604_800, 2)).toThrow(/1 week between rebuilds/);
    expect(() => assertBuildKeepsUpWithRaw(604_800, 2)).toThrow(/shortest raw window/);
    expect(() => assertBuildKeepsUpWithRaw(604_800, 2)).toThrow(/Build at least every 1 day/);
  });

  it('permits any build cadence when raw is kept forever', () => {
    // 0 is KEEP FOREVER and therefore the LARGEST window, not the smallest — a naive comparison
    // gets this backwards and refuses every schedule on a platform that deletes nothing.
    expect(() => assertBuildKeepsUpWithRaw(604_800, 0)).not.toThrow();
  });

  it('raises the raw floor to cover the build gap, which is the same rule from the other side', () => {
    // Either write can make the pair unsafe, so both go through one function.
    expect(rawFloorDays(3)).toBe(3);
    expect(rawFloorDays(3, 14)).toBe(14);
    expect(rawDaysNeededForGap(604_800)).toBe(14);
  });
});

describe('saying what a schedule does', () => {
  it('describes the shapes an admin actually picks', () => {
    expect(describeSchedule('0 0 3 * * *', TZ)).toBe('Every day at 03:00 (Asia/Jerusalem)');
    expect(describeSchedule('*/15 * * * *', TZ)).toBe('Every 15 minutes (Asia/Jerusalem)');
    expect(describeSchedule('0 0 */6 * * *', TZ)).toBe('Every 6 hours at :00 (Asia/Jerusalem)');
    expect(describeSchedule('0 0 3 * * 0', TZ)).toBe('Every Sunday at 03:00 (Asia/Jerusalem)');
    expect(describeSchedule('0 0 3 1 * *', TZ)).toBe(
      'The 1st of every month at 03:00 (Asia/Jerusalem)',
    );
  });

  it('falls back to the expression rather than guessing', () => {
    // The sentence is what an admin checks their intent against, so being wrong here is worse than
    // being silent.
    expect(describeSchedule('0 7 3 5,17 3 2', TZ)).toBe('0 7 3 5,17 3 2 (Asia/Jerusalem)');
    expect(describeSchedule('not a cron', TZ)).toBe('not a cron');
  });

  it('names a duration the way a person would say it', () => {
    expect(describeGap(900)).toBe('15 minutes');
    expect(describeGap(86_400)).toBe('1 day');
    expect(describeGap(Infinity)).toBe('never');
  });

  it('names what is running from the job, not only the trigger', () => {
    // A 409 saying "a nightly cleanup is already running" when what is running is a summary rebuild
    // names the wrong thing to whoever is being refused.
    expect(describeSweep('cron', 'build')).toBe('summary rebuild');
    expect(describeSweep('cron', 'sweep')).toBe('data cleanup');
    expect(describeSweep('catchup', 'orphan')).toBe('orphan cleanup');
    expect(describeSweep('admin', 'full')).toBe('platform cleanup');
  });

  it('knows the four jobs and rejects anything else', () => {
    expect(RETENTION_JOBS).toHaveLength(4);
    expect(isRetentionJob('data_sweep')).toBe(true);
    expect(isRetentionJob('nightly')).toBe(false);
    expect(describeJob('bucket_delete')).toBe('summary cleanup');
  });
});

describe('deciding a job is due', () => {
  const slot = new Date('2026-09-07T03:00:00Z');
  const now = new Date('2026-09-07T09:00:00Z');

  it('is due when it has never run', () => {
    expect(isJobDue(null, slot, now)).toBe(true);
  });

  it('is not due when it already ran for this slot', () => {
    expect(isJobDue(new Date('2026-09-07T03:00:30Z'), slot, now)).toBe(false);
  });

  it('is due when the last run predates the slot', () => {
    // The catch-up, and the whole reason a missed night is survivable: node-cron would simply have
    // skipped it, with nothing written anywhere to say so.
    expect(isJobDue(new Date('2026-09-06T03:00:00Z'), slot, now)).toBe(true);
  });

  it('is never due when the schedule yields no occurrence', () => {
    // What `enabled: false` reduces to. The old fixed 25h fuse ignored this and swept anyway, which
    // made switching a job off hold for a day and then quietly stop meaning anything.
    expect(isJobDue(null, null, now)).toBe(false);
  });

  it('holds off inside the grace window so a slot is not claimed twice', () => {
    expect(isJobDue(null, slot, new Date('2026-09-07T03:00:10Z'), 60_000)).toBe(false);
  });
});
