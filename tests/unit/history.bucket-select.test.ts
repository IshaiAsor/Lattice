// Unit: history domain — query planning for the series API
// (api/src/services/history-bucket.ts). Which table a range reads from, and how a range and a page
// size are normalised before they reach Prisma.

import {
  selectBucket,
  resolveRange,
  clampLimit,
} from '../../services/api/src/services/history-bucket';

const hoursApart = (h: number) => {
  const to = new Date('2026-08-21T12:00:00Z');
  return { from: new Date(to.getTime() - h * 3_600_000), to };
};

describe('selectBucket', () => {
  it('reads raw rows for a short range', () => {
    const { from, to } = hoursApart(24);
    expect(selectBucket(from, to)).toBe('raw');
  });

  it('reads hourly buckets for a range of weeks', () => {
    const { from, to } = hoursApart(7 * 24);
    expect(selectBucket(from, to)).toBe('hour');
  });

  it('reads daily buckets for a range of months', () => {
    const { from, to } = hoursApart(120 * 24);
    expect(selectBucket(from, to)).toBe('day');
  });

  it('honours an explicit hourly request on a short range', () => {
    const { from, to } = hoursApart(6);
    expect(selectBucket(from, to, 'hour')).toBe('hour');
  });

  it('refuses raw for a range wider than raw retention', () => {
    // Raw rows may not exist at all once pruning has run, so a client asking for them over a year
    // must get the answer that does exist rather than an empty chart.
    const { from, to } = hoursApart(365 * 24);
    expect(selectBucket(from, to, 'raw')).toBe('day');
  });

  it('allows raw when it was asked for and the range is narrow', () => {
    const { from, to } = hoursApart(12);
    expect(selectBucket(from, to, 'raw')).toBe('raw');
  });

  it('ignores an unrecognised bucket and picks automatically', () => {
    const { from, to } = hoursApart(12);
    expect(selectBucket(from, to, 'fortnight')).toBe('raw');
  });
});

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
