// Unit: history domain — the pure retention arithmetic
// (automation-worker/src/services/retention-logic.ts). Two encodings meet in this file and they
// are deliberately different: on a *_days column 0 means KEEP FOREVER, while on a max_* ceiling
// NULL means UNCAPPED. Getting that backwards deletes people's history, so it is pinned here.

import {
  clampDays,
  resolveRetention,
  pruneCutoff,
  hourStart,
  dayStart,
  emptyBucket,
  foldReading,
  bucketAvg,
  type PlatformPolicy,
} from '../../services/automation-worker/src/services/retention-logic';
import {
  defaultAboveCeiling,
  assertDefaultWithinCeiling,
} from '../../services/api/src/services/retention-rules';

const policy = (over: Partial<PlatformPolicy> = {}): PlatformPolicy => ({
  data_kind: 'scalar',
  default_raw_days: 14,
  default_hourly_days: 90,
  default_daily_days: 0,
  max_raw_days: null,
  max_hourly_days: null,
  max_daily_days: null,
  enabled: true,
  ...over,
});

describe('clampDays', () => {
  it('takes the platform default when the user has chosen nothing', () => {
    expect(clampDays(undefined, 14, null)).toBe(14);
  });

  it('takes the user choice over the default', () => {
    expect(clampDays(30, 14, null)).toBe(30);
  });

  it('leaves a choice alone when there is no ceiling', () => {
    expect(clampDays(3650, 14, null)).toBe(3650);
  });

  it('clamps a choice that exceeds the ceiling', () => {
    expect(clampDays(365, 14, 90)).toBe(90);
  });

  it('leaves a choice below the ceiling alone', () => {
    expect(clampDays(30, 14, 90)).toBe(30);
  });

  it('clamps forever to the ceiling', () => {
    // 0 is the LARGEST value even though it is numerically the smallest — Math.min would have
    // returned 0 here and kept everything forever, which is the exact opposite of a cap.
    expect(clampDays(0, 14, 90)).toBe(90);
  });

  it('keeps forever when no ceiling is set', () => {
    expect(clampDays(0, 14, null)).toBe(0);
  });

  it('passes a null tier through as null', () => {
    expect(clampDays(null, null, null)).toBe(null);
  });
});

describe('resolveRetention', () => {
  it('follows the platform default when the user has no preference row', () => {
    const w = resolveRetention(policy(), undefined);
    expect(w.raw_days).toBe(14);
    expect(w.hourly_days).toBe(90);
    expect(w.daily_days).toBe(0);
  });

  it('applies a user override', () => {
    const w = resolveRetention(policy(), {
      data_kind: 'scalar',
      raw_days: 30,
      hourly_days: null,
      daily_days: null,
    });
    expect(w.raw_days).toBe(30);
  });

  it('binds a user override to the admin ceiling', () => {
    const w = resolveRetention(policy({ max_raw_days: 21 }), {
      data_kind: 'scalar',
      raw_days: 0,
      hourly_days: null,
      daily_days: null,
    });
    expect(w.raw_days).toBe(21);
  });

  it('carries the platform enabled switch through', () => {
    expect(resolveRetention(policy({ enabled: false }), undefined).enabled).toBe(false);
  });
});

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
describe('defaultAboveCeiling', () => {
  it('lets any default through when the ceiling is uncapped', () => {
    expect(defaultAboveCeiling(365, null)).toBe(false);
    expect(defaultAboveCeiling(0, null)).toBe(false);
  });

  it('treats forever as above every finite ceiling', () => {
    expect(defaultAboveCeiling(0, 7)).toBe(true);
    expect(defaultAboveCeiling(0, 3650)).toBe(true);
  });

  it('allows a default at or under the ceiling', () => {
    expect(defaultAboveCeiling(7, 7)).toBe(false);
    expect(defaultAboveCeiling(6, 7)).toBe(false);
  });

  it('rejects a default over the ceiling', () => {
    expect(defaultAboveCeiling(14, 7)).toBe(true);
  });
});

describe('assertDefaultWithinCeiling', () => {
  it('is silent on a valid pair', () => {
    expect(() => assertDefaultWithinCeiling(7, 7)).not.toThrow();
    expect(() => assertDefaultWithinCeiling(0, null)).not.toThrow();
  });

  it('throws a 400 naming both numbers', () => {
    expect(() => assertDefaultWithinCeiling(14, 7)).toThrow(/14 days.*ceiling of 7 days/);
    try {
      assertDefaultWithinCeiling(14, 7);
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('says "forever" rather than 0 when that is the breach', () => {
    expect(() => assertDefaultWithinCeiling(0, 30)).toThrow(/forever/);
  });

  it('does not write "1 days"', () => {
    expect(() => assertDefaultWithinCeiling(7, 1)).toThrow('ceiling of 1 day —');
  });
});
