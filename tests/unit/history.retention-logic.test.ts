// Unit: history domain — the pure retention arithmetic that survived Phase 2 (@lattice/retention).
//
// The `0 = forever` encoding still runs through all of it, and getting that backwards deletes
// people's history, so it stays pinned here. What LEFT this file is the three-column ceiling
// arithmetic — `clampDays`, `resolveRetention`, `defaultAboveCeiling`,
// `assertDefaultWithinCeiling`. Those were superseded by `assertTierList`, which enforces a ceiling
// per tier rather than per fixed column, and by then they had no production caller at all: this
// suite was the only thing keeping them compiled. The equivalent cases now live in
// history.retention-tiers.test.ts and history.retention-activity.test.ts.

import {
  pruneCutoff,
  hourStart,
  dayStart,
  emptyBucket,
  foldReading,
  bucketAvg,
} from '../../packages/retention/src';

describe('pruneCutoff', () => {
  const now = new Date('2026-08-21T12:00:00Z');

  it('returns a cutoff that many days back', () => {
    expect(pruneCutoff(14, true, now)?.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it('deletes nothing when the window is forever', () => {
    expect(pruneCutoff(0, true, now)).toBe(null);
  });

  it('deletes nothing when the kind is disabled', () => {
    expect(pruneCutoff(14, false, now)).toBe(null);
  });

  it('deletes nothing for a null tier', () => {
    expect(pruneCutoff(null, true, now)).toBe(null);
  });
});

describe('bucket boundaries', () => {
  it('truncates to the start of the UTC hour', () => {
    expect(hourStart(new Date('2026-08-21T14:37:22.500Z')).toISOString()).toBe(
      '2026-08-21T14:00:00.000Z',
    );
  });

  it('truncates to midnight UTC', () => {
    expect(dayStart(new Date('2026-08-21T14:37:22.500Z')).toISOString()).toBe(
      '2026-08-21T00:00:00.000Z',
    );
  });
});

describe('foldReading', () => {
  it('aggregates a numeric series', () => {
    const b = emptyBucket();
    for (const v of ['21.5', '23.0', '19.5']) foldReading(b, v, false);
    expect(b.sample_count).toBe(3);
    expect(b.numeric_count).toBe(3);
    expect(b.min_value).toBe(19.5);
    expect(b.max_value).toBe(23);
    expect(bucketAvg(b)).toBeCloseTo(21.333, 3);
    expect(b.last_value).toBe('19.5');
  });

  it('counts a non-numeric series without inventing an average', () => {
    // A switch's history is "on"/"off". It still deserves a bucket — how many readings, what it
    // ended on — but an average of it would be meaningless, not zero.
    const b = emptyBucket();
    for (const v of ['on', 'off', 'on']) foldReading(b, v, false);
    expect(b.sample_count).toBe(3);
    expect(b.numeric_count).toBe(0);
    expect(bucketAvg(b)).toBe(null);
    expect(b.min_value).toBe(null);
    expect(b.last_value).toBe('on');
  });

  it('counts a fault as a sample but not as a value', () => {
    // The chart draws this as a marker, not as a dip to zero.
    const b = emptyBucket();
    foldReading(b, '21.5', false);
    foldReading(b, null, true);
    expect(b.sample_count).toBe(2);
    expect(b.numeric_count).toBe(1);
    expect(b.error_count).toBe(1);
    expect(bucketAvg(b)).toBe(21.5);
  });

  it('does not treat an empty reading as zero', () => {
    // Number('') is 0, which would quietly drag every average toward zero.
    const b = emptyBucket();
    foldReading(b, '21.5', false);
    foldReading(b, '  ', false);
    expect(b.numeric_count).toBe(1);
    expect(bucketAvg(b)).toBe(21.5);
  });

  it('mixes numeric and non-numeric without corrupting the average', () => {
    const b = emptyBucket();
    foldReading(b, '10', false);
    foldReading(b, 'unavailable', false);
    foldReading(b, '20', false);
    expect(b.sample_count).toBe(3);
    expect(b.numeric_count).toBe(2);
    expect(bucketAvg(b)).toBe(15);
  });
});

// The admin page's half of the same encoding: what the worker silently clamps, the API refuses to
// store, so the number an admin reads is the number their users get.
