// Cron-side phase selection. The *timing* half of this (durations, elapsed, the due check) moved
// to `@lattice/params` when phases gained a per-phase time bank: api renders the same countdown
// the cron acts on, so one definition has to serve both. What stays here is the part only the cron
// asks — which phase comes next.

/**
 * The phase that follows `currentOrdinal` — the next-highest ordinal, not `ordinal + 1`, so a
 * blueprint numbered 10/20/30 (or one whose middle phase was removed in a v2) still advances.
 */
export function nextPhase<T extends { ordinal: number }>(
  phases: T[],
  currentOrdinal: number,
): T | null {
  const later = phases
    .filter((p) => p.ordinal > currentOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  return later[0] ?? null;
}
