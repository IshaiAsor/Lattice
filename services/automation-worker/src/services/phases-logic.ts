// Cron-side phase selection. The *timing* half of this (durations, elapsed, the due check) moved
// to `@lattice/params` when phases gained a per-phase time bank: api renders the same countdown
// the cron acts on, so one definition has to serve both. What stays here is the part only the cron
// asks — which phase comes next, and where a phase says to go.

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

/**
 * Where advancing this phase lands — the one place that reads `advance_to_key`, so every trigger
 * (schedule / rule / pipeline) resolves the target identically: the phase owns *where*, the trigger
 * only says *when*.
 *
 * `toKey` set ⇒ that phase, wherever it sits in the profile's order (a phase may jump or, for a
 * hand-authored rewind, go back). `toKey` null ⇒ the next by ordinal. Returns null — a no-op — when
 * the target does not exist, the phase is already the last, or the target *is* the current phase
 * (idempotent: a repeat trigger cannot re-advance or double-bank).
 */
export function resolveAdvanceTarget<T extends { key: string; ordinal: number }>(
  phases: T[],
  currentOrdinal: number,
  toKey: string | null | undefined,
): T | null {
  const current = phases.find((p) => p.ordinal === currentOrdinal);
  const target = toKey
    ? (phases.find((p) => p.key === toKey) ?? null)
    : nextPhase(phases, currentOrdinal);
  if (!target) return null;
  if (current && target.key === current.key) return null;
  return target;
}
