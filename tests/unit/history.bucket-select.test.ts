// Unit: history domain — query planning for the series API. Which TIER a range reads from
// (`selectTier`, @lattice/retention), and how a range and a page size are normalised before they
// reach Prisma (`history-bucket.ts`).

import { resolveRange, clampLimit } from '../../services/api/src/services/history-bucket';
import { selectTier, type ResolvedTier } from '../../packages/retention/src';

describe('resolveRange', () => {
  const now = new Date('2026-08-21T12:00:00Z');

  it('defaults to the last seven days', () => {
    const { from, to } = resolveRange(undefined, undefined, now);
    expect(to.toISOString()).toBe('2026-08-21T12:00:00.000Z');
    expect(from.toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });

  it('takes an explicit range', () => {
    const r = resolveRange('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', now);
    expect(r.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-08-02T00:00:00.000Z');
  });

  it('swaps a reversed range rather than returning nothing', () => {
    const r = resolveRange('2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z', now);
    expect(r.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('falls back to the default window on an unparseable date', () => {
    // A bad ?from= on a dashboard should show the usual week, not blank the page with a 400.
    const { from } = resolveRange('last tuesday', undefined, now);
    expect(from.toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });
});

describe('clampLimit', () => {
  it('defaults when the limit is missing', () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  it('caps at the maximum', () => {
    expect(clampLimit(5000)).toBe(200);
  });

  it('rejects zero and negatives', () => {
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(-10)).toBe(50);
  });

  it('ignores a non-numeric limit', () => {
    expect(clampLimit('all')).toBe(50);
  });
});

// ── The N-tier ladder (F18.9) ────────────────────────────────────────────────
//
// The history API used to answer with one of three hard-coded names (`selectBucket`, deleted).
// `selectTier` answers from the tier list actually configured for the action, which is what makes
// "an admin adds a 15m tier and the chart uses it" true without a release — and what stops the
// chart asking for a bucket the orphan sweep has legitimately removed.

const tier = (
  bucket: string,
  seconds: number,
  keepDays: number,
  position: number,
): ResolvedTier => ({
  bucket,
  seconds,
  anchorOffsetSeconds: 0,
  keepDays,
  position,
});

/** The shape a stock install resolves to: raw 14 days, hourly 90, daily forever. */
const LADDER: ResolvedTier[] = [
  tier('raw', 0, 14, 0),
  tier('1h', 3600, 90, 1),
  tier('1d', 86400, 0, 2),
];

const NOW = new Date('2026-08-24T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const pick = (tiers: ResolvedTier[], days: number, requested?: string) =>
  selectTier(tiers, ago(days), NOW, { now: NOW, requested });

describe('selectTier', () => {
  it('reads raw rows for a single day', () => {
    expect(pick(LADDER, 1)).toMatchObject({ bucket: 'raw', source: 'auto' });
  });

  it('steps up to hourly buckets once raw has been pruned', () => {
    // Raw is dropped because it was pruned at 14 days, not because of the range width — the window
    // is the decisive filter, and an empty chart reads as "the device was off".
    expect(pick(LADDER, 21)).toMatchObject({ bucket: '1h', source: 'auto' });
  });

  it('steps up to daily buckets for a range of months', () => {
    expect(pick(LADDER, 180)).toMatchObject({ bucket: '1d', source: 'auto' });
  });

  it('picks a 15-minute tier once one is added, with no code change', () => {
    // F18.9's acceptance criterion, and the whole reason the candidate set is data. On two days raw
    // costs 2880 points, 1h is only 48, and 15m at 192 is the one in between.
    const withQuarterHour = [...LADDER, tier('15m', 900, 30, 1)];
    expect(pick(LADDER, 2)).toMatchObject({ bucket: 'raw' });
    expect(pick(withQuarterHour, 2)).toMatchObject({ bucket: '15m', source: 'auto' });
  });

  it('uses a custom 90-minute tier the same way as a seeded one', () => {
    const withNinety = [...LADDER, tier('90m', 5400, 60, 1)];
    expect(pick(withNinety, 7)).toMatchObject({ bucket: '90m' });
  });

  it('skips a tier whose window no longer reaches the range', () => {
    expect(pick(LADDER, 20)?.bucket).not.toBe('raw');
  });

  it('honours an explicit request for a tier that is still available', () => {
    expect(pick(LADDER, 21, '1d')).toMatchObject({ bucket: '1d', source: 'requested' });
  });

  it('ignores a request for a tier that has been pruned', () => {
    // A request, not a command. Handing back raw for a 21-day range would draw nothing at all.
    expect(pick(LADDER, 21, 'raw')).toMatchObject({ bucket: '1h', source: 'auto' });
  });

  it('falls back to the coarsest tier when every window has been outrun', () => {
    const finite = [tier('raw', 0, 14, 0), tier('1h', 3600, 90, 1), tier('1d', 86400, 365, 2)];
    expect(pick(finite, 500)).toMatchObject({ bucket: '1d', source: 'fallback' });
  });

  it('answers from raw alone when nothing else is configured', () => {
    const rawOnly = [tier('raw', 0, 14, 0)];
    expect(pick(rawOnly, 1)).toMatchObject({ bucket: 'raw' });
    expect(pick(rawOnly, 10)).toMatchObject({ bucket: 'raw' });
  });

  it('returns null when there are no tiers at all', () => {
    expect(selectTier([], ago(1), NOW, { now: NOW })).toBeNull();
  });
});
