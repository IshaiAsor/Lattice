// Pure policy rules for the retention API — extracted so they are unit-testable
// (tests/unit/history.retention-logic.test.ts) without a DB or a transport.
//
// Two encodings meet here and they are deliberately different: on a *_days column 0 means KEEP
// FOREVER, while on a max_* ceiling NULL means UNCAPPED. `0 > any ceiling` is the consequence that
// keeps catching people out.

/**
 * Is this default above the ceiling users may not exceed?
 *
 * `0` is forever, so it is above every finite ceiling however small the number reads. A null
 * ceiling is uncapped and nothing can breach it.
 */
export function defaultAboveCeiling(chosen: number, ceiling: number | null): boolean {
  if (ceiling === null) return false;
  return chosen === 0 || chosen > ceiling;
}

/**
 * Reject a default that sits above its ceiling.
 *
 * Nothing is lost when the pair is invalid — the worker clamps to the ceiling either way — but the
 * admin page then states a window nobody gets: "every user starts on 14 days" beside "users may
 * not exceed 7". The number shown has to be the number applied.
 *
 * Raw only. The hourly/daily tiers are not editable anywhere and follow a different rule (a rollup
 * legitimately outlives the raw rows it came from), so constraining them here would reject rows
 * that shipped valid.
 */
export function assertDefaultWithinCeiling(chosen: number, ceiling: number | null): void {
  // The null check is repeated rather than delegated: TypeScript cannot narrow `ceiling` through
  // a helper's boolean return, and the message below has a real number to print.
  if (ceiling === null || !defaultAboveCeiling(chosen, ceiling)) return;
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const shown = chosen === 0 ? 'forever' : plural(chosen);
  throw Object.assign(
    new Error(
      `The default (${shown}) is above the ceiling of ${plural(ceiling)} — lower the default ` +
        `first, or raise the ceiling.`,
    ),
    { statusCode: 400 },
  );
}
