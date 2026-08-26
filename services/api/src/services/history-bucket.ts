// Pure query-planning logic for the history API — extracted so it is unit-testable
// (tests/unit/history.bucket-select.test.ts) without a DB or a transport.

// `selectBucket` and its `'raw' | '1h' | '1d'` union used to live here — three hard-coded rungs,
// chosen by range width alone. They are gone: F18.9 made the candidate set DATA, and the
// replacement is `selectTier` in @lattice/retention, which picks from the tiers actually configured
// for the action and refuses one whose rows have been pruned past the requested range.
//
// What is left here is the two helpers that were never about the vocabulary: parsing a range off a
// query string, and clamping a page size.

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
