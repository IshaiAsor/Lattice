// Unit: the N-tier retention core (@lattice/retention) — F18.9/F18.12.
//
// Phase 1 froze the tier list in code: two rollup tiers named 'hour' and 'day', six day-columns on
// one table. Phase 2 makes the list DATA — any number of tiers, any admissible size, resolvable at
// five scopes — and moves the part that cannot be data (the chain rule, the per-kind limits, the
// raw floor) into this package. This file pins that part.
//
// The single most important case in the file is "refuses a raw window shorter than the rollup
// lookback": rollups are built by reading raw rows, so a raw window below the lookback deletes
// readings before they have ever been summarised. A user shortening raw to save space would
// silently destroy the long-range history they were compressing into, and nothing downstream could
// tell that it had happened.

import {
  bucketStart,
  hourStart,
  dayStart,
  assertBucketAdmissible,
  isBucketAdmissible,
  allowedForKind,
  formatSeconds,
  resolveTiers,
  assertTierList,
  emptyBucket,
  foldRollup,
  bucketAvg,
  WEEK_ANCHOR_OFFSET_SECONDS,
  findSweepConflict,
  sweepLockKey,
  type BucketDef,
  type Tier,
  type PlatformTier,
  type RollupRow,
} from '../../packages/retention/src';

// ── The catalog, as `retention_buckets` would hand it over ───────────────────

const DEFS: BucketDef[] = [
  { code: 'raw', seconds: 0, label: 'Raw readings', anchorOffsetSeconds: 0 },
  { code: '5m', seconds: 300, label: '5 minutes', anchorOffsetSeconds: 0 },
  { code: '15m', seconds: 900, label: '15 minutes', anchorOffsetSeconds: 0 },
  { code: '30m', seconds: 1800, label: '30 minutes', anchorOffsetSeconds: 0 },
  { code: '45m', seconds: 2700, label: '45 minutes', anchorOffsetSeconds: 0 },
  { code: '1h', seconds: 3600, label: '1 hour', anchorOffsetSeconds: 0 },
  // The custom size the user asked for: 5400s, 16 to a day, in no seeded list.
  { code: '90m', seconds: 5400, label: '90 minutes', anchorOffsetSeconds: 0 },
  { code: '6h', seconds: 21600, label: '6 hours', anchorOffsetSeconds: 0 },
  { code: '1d', seconds: 86400, label: '1 day', anchorOffsetSeconds: 0 },
  {
    code: '1w',
    seconds: 604800,
    label: '1 week',
    anchorOffsetSeconds: WEEK_ANCHOR_OFFSET_SECONDS,
  },
];
const CATALOG = new Map(DEFS.map((d) => [d.code, d]));

/** A tier list from bucket codes and keep windows, positioned in the order written. */
const tiers = (...pairs: [string, number][]): Tier[] =>
  pairs.map(([bucket, keepDays], position) => ({ bucket, keepDays, position }));

/** A platform tier list, with an optional ceiling per bucket. */
const platform = (...triples: [string, number, number | null][]): PlatformTier[] =>
  triples.map(([bucket, keepDays, maxKeepDays], position) => ({
    bucket,
    keepDays,
    maxKeepDays,
    position,
  }));

const PLATFORM = platform(['raw', 14, null], ['1h', 90, null], ['1d', 0, null]);

const validate = (over: Partial<Parameters<typeof assertTierList>[1]> = {}) => ({
  kind: 'scalar' as const,
  buckets: CATALOG,
  lookbackDays: 3,
  ...over,
});

// ── Flooring ─────────────────────────────────────────────────────────────────

describe('bucketStart', () => {
  it('reproduces the UTC hour and UTC midnight for the hour and day sizes', () => {
    // Phase 1's hourStart/dayStart used setUTCMinutes/setUTCHours; the generic formula has to land
    // in exactly the same place or every bucket ever written moves by a fraction of a bucket.
    const d = new Date('2026-08-24T13:47:31.412Z');
    expect(bucketStart(d, 3600).toISOString()).toBe('2026-08-24T13:00:00.000Z');
    expect(bucketStart(d, 86400).toISOString()).toBe('2026-08-24T00:00:00.000Z');
    expect(hourStart(d).toISOString()).toBe(bucketStart(d, 3600).toISOString());
    expect(dayStart(d).toISOString()).toBe(bucketStart(d, 86400).toISOString());
  });

  it('floors a 90-minute bucket onto its own grid', () => {
    // The size the user asked for, and the whole point of making the catalog open: 5400s needs no
    // code, it just divides. 16 boundaries a day, starting at midnight.
    const at = (iso: string) => bucketStart(new Date(iso), 5400).toISOString();
    expect(at('2026-08-24T00:05:00.000Z')).toBe('2026-08-24T00:00:00.000Z');
    expect(at('2026-08-24T01:29:59.999Z')).toBe('2026-08-24T00:00:00.000Z');
    expect(at('2026-08-24T01:30:00.000Z')).toBe('2026-08-24T01:30:00.000Z');
    expect(at('2026-08-24T02:59:00.000Z')).toBe('2026-08-24T01:30:00.000Z');
    expect(at('2026-08-24T03:00:00.000Z')).toBe('2026-08-24T03:00:00.000Z');
  });

  it('starts every day of a 90-minute grid at midnight', () => {
    // The reason the admission rule exists. A size that did not divide a day would put tomorrow's
    // first boundary somewhere other than 00:00, and the same bucket would mean a different part of
    // the day depending on when you looked.
    for (const day of ['2026-08-24', '2026-08-25', '2026-12-31']) {
      expect(bucketStart(new Date(`${day}T00:00:00.000Z`), 5400).toISOString()).toBe(
        `${day}T00:00:00.000Z`,
      );
    }
  });

  it('truncates a week to Monday rather than the epoch Thursday', () => {
    // 1 Jan 1970 was a Thursday, so epoch-multiple flooring of 604800s lands on Thursdays. The
    // anchor offset is the one thing in the catalog that is not just a duration.
    const wed = new Date('2026-08-26T09:00:00.000Z'); // a Wednesday
    expect(bucketStart(wed, 604800).getUTCDay()).toBe(4); // unanchored: Thursday
    const anchored = bucketStart(wed, 604800, WEEK_ANCHOR_OFFSET_SECONDS);
    expect(anchored.getUTCDay()).toBe(1); // Monday
    expect(anchored.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('refuses to floor onto the raw tier, which has no grid', () => {
    // raw is a tier in every way that matters, but it is not a duration — rows are written one per
    // reading. Zero seconds is that encoding, and dividing by it would return an Invalid Date that
    // a Prisma upsert would happily try to write.
    expect(() => bucketStart(new Date(), 0)).toThrow(/raw has no grid/);
  });
});

// ── Admission ────────────────────────────────────────────────────────────────

describe('assertBucketAdmissible', () => {
  it('accepts 90 minutes, which divides a day sixteen times', () => {
    expect(isBucketAdmissible(5400)).toBe(true);
    expect(() => assertBucketAdmissible(5400)).not.toThrow();
    expect(86400 / 5400).toBe(16);
  });

  it('accepts a whole number of days', () => {
    expect(() => assertBucketAdmissible(86400)).not.toThrow();
    expect(() => assertBucketAdmissible(604800)).not.toThrow();
  });

  it('refuses seven hours and suggests six or eight', () => {
    expect(() => assertBucketAdmissible(25200)).toThrow(/does not divide a day evenly/);
    expect(() => assertBucketAdmissible(25200)).toThrow(/6h or 8h/);
  });

  it('refuses anything finer than a minute', () => {
    expect(() => assertBucketAdmissible(30)).toThrow(/finer than the 1 minute minimum/);
    expect(isBucketAdmissible(30)).toBe(false);
  });

  it('refuses a fractional size', () => {
    expect(() => assertBucketAdmissible(90.5)).toThrow(/whole number of seconds/);
  });

  it('names a size the way a human would type it', () => {
    expect(formatSeconds(5400)).toBe('90m');
    expect(formatSeconds(3600)).toBe('1h');
    expect(formatSeconds(86400)).toBe('1d');
    // A week is also a whole number of days and of hours, so the coarsest unit has to win.
    expect(formatSeconds(604800)).toBe('1w');
    expect(formatSeconds(0)).toBe('raw');
  });
});

describe('allowedForKind', () => {
  it('lets a scalar use any bucket', () => {
    for (const d of DEFS) expect(allowedForKind('scalar', d.seconds)).toBe(true);
  });

  it('restricts command and event history to whole days', () => {
    // command_rollup_daily and device_availability_daily are keyed on a DATE — an hourly command
    // bucket has nowhere to be written.
    for (const kind of ['command', 'device_event'] as const) {
      expect(allowedForKind(kind, 86400)).toBe(true);
      expect(allowedForKind(kind, 604800)).toBe(true);
      expect(allowedForKind(kind, 3600)).toBe(false);
      expect(allowedForKind(kind, 5400)).toBe(false);
    }
  });

  it('gives camera frames raw and nothing else', () => {
    // A frame is an image. There is no average of two photographs.
    expect(allowedForKind('frame', 0)).toBe(true);
    expect(allowedForKind('frame', 86400)).toBe(false);
  });

  it('lets every kind keep raw rows', () => {
    // This is what "raw is a tier" buys: frame's tier list is raw and nothing else, and it is still
    // a tier list rather than a special case.
    for (const kind of ['scalar', 'frame', 'command', 'device_event'] as const) {
      expect(allowedForKind(kind, 0)).toBe(true);
    }
  });
});

// ── The chain ────────────────────────────────────────────────────────────────

describe('assertTierList', () => {
  it('accepts a chain that folds evenly at every step', () => {
    // 15m → 90m is 6×, 90m → 1d is 16×. A custom size is perfectly legal in a chain; it is the
    // list that has to divide, not the size.
    expect(() =>
      assertTierList(tiers(['raw', 14], ['15m', 30], ['90m', 180], ['1d', 0]), validate()),
    ).not.toThrow();
    expect(() =>
      assertTierList(tiers(['raw', 14], ['90m', 180], ['1d', 0]), validate()),
    ).not.toThrow();
  });

  it('refuses a bucket that is not a whole multiple of the one below it', () => {
    expect(() => assertTierList(tiers(['raw', 14], ['1h', 90], ['90m', 180]), validate())).toThrow(
      /90m cannot fold from 1h/,
    );
  });

  it('names both sizes and suggests a predecessor that would work', () => {
    // The rule is not obvious from the numbers — 90m above 1h looks fine until you divide — so the
    // refusal has to do the arithmetic out loud.
    let message = '';
    try {
      assertTierList(tiers(['raw', 14], ['1h', 90], ['90m', 180]), validate());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/1\.5×/);
    expect(message).toMatch(/use 30m or 45m below it/);
  });

  it('sorts before checking the chain, so the stored order cannot hide a break', () => {
    expect(() => assertTierList(tiers(['90m', 180], ['raw', 14], ['1h', 90]), validate())).toThrow(
      /cannot fold/,
    );
  });

  it('requires a raw tier', () => {
    expect(() => assertTierList(tiers(['1h', 90], ['1d', 0]), validate())).toThrow(
      /starts with the raw tier/,
    );
  });

  it('refuses an empty list', () => {
    expect(() => assertTierList([], validate())).toThrow(/at least the raw tier/);
  });

  it('refuses the same bucket twice', () => {
    expect(() => assertTierList(tiers(['raw', 14], ['1h', 90], ['1h', 30]), validate())).toThrow(
      /listed twice/,
    );
  });

  it('does not cap how many tiers a kind may hold', () => {
    // There is deliberately no count limit (user's call, 2026-08-26). A count was the wrong axis:
    // cost is dominated by the FINEST bucket, so this six-tier list costs 336 rollup rows per
    // sensor per day for its 5m tier and about one for everything above it. What bounds a list is
    // `min_bucket` and the chain rule -- each tier a whole multiple of the one below.
    expect(() =>
      assertTierList(
        tiers(['raw', 14], ['5m', 7], ['15m', 30], ['1h', 90], ['1d', 0], ['1w', 0]),
        validate(),
      ),
    ).not.toThrow();
  });

  it('refuses a bucket finer than the platform minimum', () => {
    expect(() =>
      assertTierList(tiers(['raw', 14], ['5m', 7], ['1h', 90]), validate({ minBucket: '15m' })),
    ).toThrow(/5m is finer than the 15m minimum/);
  });

  it('never treats raw as below the platform minimum', () => {
    // The minimum is about how fine a summary may be. Raw is not a summary, so a min_bucket of 15m
    // still keeps the readings themselves for as long as the raw tier says.
    expect(() =>
      assertTierList(tiers(['raw', 14], ['1h', 90]), validate({ minBucket: '15m' })),
    ).not.toThrow();
  });

  it('refuses a bucket the kind cannot roll up', () => {
    expect(() =>
      assertTierList(tiers(['raw', 14], ['1h', 90]), validate({ kind: 'command' })),
    ).toThrow(/1h cannot be used for command history/);
  });

  it('refuses a tier above its platform ceiling', () => {
    expect(() =>
      assertTierList(
        tiers(['raw', 30]),
        validate({ ceilings: new Map([['raw', 7]]), lookbackDays: 3 }),
      ),
    ).toThrow(/above the ceiling of 7 days/);
  });

  it('treats a forever tier as above every finite ceiling', () => {
    expect(() =>
      assertTierList(tiers(['raw', 0]), validate({ ceilings: new Map([['raw', 7]]) })),
    ).toThrow(/forever.*above the ceiling/);
  });

  it('refuses a raw window shorter than the rollup lookback', () => {
    // THE invariant. The finest rollup tier reads raw rows to build itself, so raw pruned at 2 days
    // under a 3-day lookback deletes readings that were never summarised — and the loss is
    // invisible, because the rollup rows that would have shown it were never written.
    expect(() =>
      assertTierList(tiers(['raw', 2], ['1h', 90]), validate({ lookbackDays: 3 })),
    ).toThrow(/at least 3 days while any rollup tier exists/);
  });

  it('keeps a two-day floor under raw even when the lookback is shorter', () => {
    // The nightly pass can miss a night. One day of raw with any rollup tier means a missed pass is
    // a permanent hole.
    expect(() =>
      assertTierList(tiers(['raw', 1], ['1h', 90]), validate({ lookbackDays: 1 })),
    ).toThrow(/at least 2 days/);
  });

  it('lets a forever raw window through under any lookback', () => {
    expect(() =>
      assertTierList(tiers(['raw', 0], ['1h', 90]), validate({ lookbackDays: 30 })),
    ).not.toThrow();
  });

  it('applies no raw floor when the list has no rollup tier', () => {
    // A frame list is raw and nothing else. There is nothing being built from those rows, so a
    // one-day window is a legitimate choice rather than a trap.
    expect(() =>
      assertTierList(tiers(['raw', 1]), validate({ kind: 'frame', lookbackDays: 3 })),
    ).not.toThrow();
  });

  it('refuses a negative or fractional keep window', () => {
    expect(() => assertTierList(tiers(['raw', -1]), validate())).toThrow(/whole number of days/);
    expect(() => assertTierList(tiers(['raw', 2.5]), validate())).toThrow(/whole number of days/);
  });

  it('refuses a keep window past a decade', () => {
    expect(() => assertTierList(tiers(['raw', 4000]), validate())).toThrow(/may not exceed 3650/);
  });
});

// ── Resolution across the five scopes ────────────────────────────────────────

describe('resolveTiers', () => {
  const base = { kind: 'scalar' as const, buckets: CATALOG, platform: PLATFORM };

  it('falls back to the platform list when nothing else is configured', () => {
    const r = resolveTiers({ ...base });
    expect(r.source).toBe('platform');
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw', '1h', '1d']);
  });

  it('takes the user list over the platform list', () => {
    const r = resolveTiers({ ...base, user: tiers(['raw', 30], ['1d', 0]) });
    expect(r.source).toBe('user');
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw', '1d']);
  });

  it('takes the blueprint list over the user list', () => {
    const r = resolveTiers({
      ...base,
      user: tiers(['raw', 30]),
      blueprint: tiers(['raw', 7], ['15m', 30]),
    });
    expect(r.source).toBe('blueprint');
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw', '15m']);
  });

  it('takes the device list over the blueprint list', () => {
    const r = resolveTiers({
      ...base,
      blueprint: tiers(['raw', 7], ['15m', 30]),
      device: tiers(['raw', 3]),
    });
    expect(r.source).toBe('device');
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw']);
  });

  it('takes the action list over the device list', () => {
    const r = resolveTiers({
      ...base,
      device: tiers(['raw', 3]),
      action: tiers(['raw', 60], ['5m', 14], ['1h', 365]),
    });
    expect(r.source).toBe('action');
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw', '5m', '1h']);
  });

  it('takes the whole list from one scope rather than merging tiers', () => {
    // The decision F18.12's acceptance criterion rests on. If a user list could inherit the
    // platform's rollup tiers, "removing the action tier falls back to the device" would have no
    // single answer — half-inherited lists compose differently depending on which half you remove.
    const r = resolveTiers({ ...base, user: tiers(['raw', 30]) });
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw']);
  });

  it('falls back to the device list when the action rows are removed', () => {
    const withAction = resolveTiers({
      ...base,
      device: tiers(['raw', 3], ['1d', 0]),
      action: tiers(['raw', 60]),
    });
    expect(withAction.source).toBe('action');
    const removed = resolveTiers({ ...base, device: tiers(['raw', 3], ['1d', 0]), action: [] });
    expect(removed.source).toBe('device');
    expect(removed.tiers.map((t) => t.bucket)).toEqual(['raw', '1d']);
  });

  it('clamps each tier against the platform ceiling for the same bucket', () => {
    const r = resolveTiers({
      ...base,
      platform: platform(['raw', 14, 7], ['1h', 90, 180]),
      user: tiers(['raw', 30], ['1h', 90]),
    });
    expect(r.tiers.map((t) => [t.bucket, t.keepDays])).toEqual([
      ['raw', 7],
      ['1h', 90],
    ]);
  });

  it('clamps a forever tier down to the ceiling', () => {
    // Forever is the LARGEST value despite being numerically the smallest. Math.min here would keep
    // everything forever, which is the exact opposite of a cap.
    const r = resolveTiers({
      ...base,
      platform: platform(['raw', 14, 7]),
      user: tiers(['raw', 0]),
    });
    expect(r.tiers[0]!.keepDays).toBe(7);
  });

  it('leaves a bucket the platform does not configure uncapped', () => {
    // The platform expresses a ceiling by carrying the bucket, not by omitting it — otherwise
    // adding a custom size to your own list would silently inherit an unrelated tier's limit.
    const r = resolveTiers({
      ...base,
      platform: platform(['raw', 14, 7]),
      user: tiers(['raw', 3], ['90m', 3650]),
    });
    expect(r.tiers.map((t) => [t.bucket, t.keepDays])).toEqual([
      ['raw', 3],
      ['90m', 3650],
    ]);
  });

  it('rejects a bucket that is not in the catalog, with a reason', () => {
    const r = resolveTiers({ ...base, user: tiers(['raw', 14], ['nope', 30]) });
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw']);
    expect(r.rejected).toEqual([{ bucket: 'nope', reason: 'not in the bucket catalog' }]);
  });

  it('rejects a bucket the kind cannot roll up, with a reason', () => {
    const r = resolveTiers({
      ...base,
      kind: 'frame',
      user: tiers(['raw', 7], ['1h', 30]),
    });
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw']);
    expect(r.rejected[0]!.reason).toMatch(/no average of two photographs/);
  });

  it('rejects a bucket finer than the platform minimum but keeps raw', () => {
    const r = resolveTiers({
      ...base,
      minBucket: '1h',
      user: tiers(['raw', 14], ['15m', 30], ['1d', 0]),
    });
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw', '1d']);
    expect(r.rejected[0]!.reason).toMatch(/finer than the 1h minimum/);
  });

  it('rejects the same bucket listed twice rather than folding it in once', () => {
    const r = resolveTiers({ ...base, user: tiers(['raw', 14], ['raw', 30]) });
    expect(r.tiers).toHaveLength(1);
    expect(r.tiers[0]!.keepDays).toBe(14);
    expect(r.rejected).toEqual([{ bucket: 'raw', reason: 'listed twice' }]);
  });

  it('sorts the tiers by size and renumbers their positions', () => {
    // The fold chain reads this list in order and builds each tier from its predecessor, so a
    // stored position that disagrees with the sizes must not be able to make a coarse bucket fold
    // from one that has not been written yet.
    const r = resolveTiers({ ...base, user: tiers(['1d', 0], ['raw', 14], ['90m', 180]) });
    expect(r.tiers.map((t) => t.bucket)).toEqual(['raw', '90m', '1d']);
    expect(r.tiers.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it('carries each bucket size and anchor through to the caller', () => {
    // The worker floors with these; a resolver that returned codes alone would send it back to the
    // catalog per action, which is the N+1 the extraction exists to avoid.
    const r = resolveTiers({ ...base, user: tiers(['raw', 14], ['1w', 0]) });
    expect(r.tiers[1]).toMatchObject({
      bucket: '1w',
      seconds: 604800,
      anchorOffsetSeconds: WEEK_ANCHOR_OFFSET_SECONDS,
    });
  });

  it('returns nothing to prune with when no scope is configured at all', () => {
    // A missing policy is a configuration accident, and the cost of guessing wrong is
    // unrecoverable — so an empty list means the sweep deletes nothing, never everything.
    const r = resolveTiers({ ...base, platform: [] });
    expect(r.tiers).toEqual([]);
    expect(r.source).toBe('platform');
  });
});

// ── Folding a tier from the one below it ─────────────────────────────────────

describe('foldRollup', () => {
  const row = (over: Partial<RollupRow> = {}): RollupRow => ({
    sample_count: 0,
    numeric_count: 0,
    error_count: 0,
    min_value: null,
    max_value: null,
    avg_value: null,
    last_value: null,
    ...over,
  });

  it('averages from counts rather than averaging averages', () => {
    // The reason a coarse tier can be folded from a finer one at all. An hour with 2 readings and
    // an hour with 300 are not worth the same; averaging the two averages gives 15, and the true
    // mean of the 302 readings is 19.93.
    const b = emptyBucket();
    foldRollup(b, row({ sample_count: 2, numeric_count: 2, avg_value: 10 }));
    foldRollup(b, row({ sample_count: 300, numeric_count: 300, avg_value: 20 }));
    expect(b.numeric_count).toBe(302);
    expect(bucketAvg(b)).toBeCloseTo(6020 / 302, 6);
    expect(bucketAvg(b)).not.toBeCloseTo(15, 1);
  });

  it('carries min and max up from the children', () => {
    const b = emptyBucket();
    foldRollup(
      b,
      row({ sample_count: 5, numeric_count: 5, avg_value: 8, min_value: 5, max_value: 12 }),
    );
    foldRollup(
      b,
      row({ sample_count: 5, numeric_count: 5, avg_value: 9, min_value: 1, max_value: 30 }),
    );
    expect(b.min_value).toBe(1);
    expect(b.max_value).toBe(30);
  });

  it('counts a child with no numeric readings without inventing an average', () => {
    // A switch's history is on/off. The bucket still says how many readings there were; it just has
    // no mean, and a stored NULL average must not be read back as zero.
    const b = emptyBucket();
    foldRollup(b, row({ sample_count: 4, numeric_count: 0, avg_value: null, last_value: 'on' }));
    expect(b.sample_count).toBe(4);
    expect(b.numeric_count).toBe(0);
    expect(bucketAvg(b)).toBeNull();
  });

  it('sums fault counts across the children', () => {
    const b = emptyBucket();
    foldRollup(b, row({ sample_count: 10, error_count: 2 }));
    foldRollup(b, row({ sample_count: 10, error_count: 3 }));
    expect(b.error_count).toBe(5);
    expect(b.sample_count).toBe(20);
  });

  it('takes the last value from the last child that has one', () => {
    const b = emptyBucket();
    foldRollup(b, row({ sample_count: 1, last_value: 'first' }));
    foldRollup(b, row({ sample_count: 1, last_value: null }));
    foldRollup(b, row({ sample_count: 1, last_value: 'last' }));
    expect(b.last_value).toBe('last');
  });

  it('produces the same average as folding the raw readings would have', () => {
    // The property that makes the chain trustworthy: a 1d bucket built from 1h buckets equals a 1d
    // bucket built from the readings. If this drifts, every coarse tier is quietly wrong.
    const readings = [1, 2, 3, 40, 50, 60, 700];
    const split = [readings.slice(0, 3), readings.slice(3, 6), readings.slice(6)];
    const chained = emptyBucket();
    for (const group of split) {
      const sum = group.reduce((a, n) => a + n, 0);
      foldRollup(
        chained,
        row({
          sample_count: group.length,
          numeric_count: group.length,
          avg_value: sum / group.length,
          min_value: Math.min(...group),
          max_value: Math.max(...group),
        }),
      );
    }
    const direct = readings.reduce((a, n) => a + n, 0) / readings.length;
    expect(bucketAvg(chained)).toBeCloseTo(direct, 9);
    expect(chained.min_value).toBe(1);
    expect(chained.max_value).toBe(700);
  });
});

// ── Who may sweep while who else is sweeping ─────────────────────────────────

describe('findSweepConflict', () => {
  const active = (id: number, lockKey: string | null) => ({
    id,
    lockKey,
    trigger: 'cron',
    status: 'running',
  });

  it('names the lock key a scope would hold', () => {
    expect(sweepLockKey(null)).toBe('global');
    expect(sweepLockKey(7)).toBe('user:7');
  });

  it('lets a sweep start when nothing is running', () => {
    expect(findSweepConflict(null, [])).toBeNull();
    expect(findSweepConflict(7, [])).toBeNull();
  });

  it('refuses a platform sweep while any run is active', () => {
    // A global pass touches every row, so anything at all conflicts with it.
    expect(findSweepConflict(null, [active(1, 'global')])?.id).toBe(1);
    expect(findSweepConflict(null, [active(2, 'user:3')])?.id).toBe(2);
  });

  it('refuses a user sweep while the platform sweep is running', () => {
    expect(findSweepConflict(7, [active(1, 'global')])?.id).toBe(1);
  });

  it('refuses a second sweep for the same user', () => {
    expect(findSweepConflict(7, [active(5, 'user:7')])?.id).toBe(5);
  });

  it('lets two different users sweep at once', () => {
    // The reason the lock is two-level rather than one global key: these touch disjoint,
    // ownership-scoped rows, and serialising them would make one user's Apply wait on a
    // stranger's.
    expect(findSweepConflict(7, [active(5, 'user:9')])).toBeNull();
    expect(findSweepConflict(7, [active(5, 'user:9'), active(6, 'user:12')])).toBeNull();
  });

  it('takes the oldest conflicting run, so the refusal names the one actually running', () => {
    const conflict = findSweepConflict(null, [active(3, 'user:1'), active(4, 'global')]);
    expect(conflict?.id).toBe(3);
  });
});
