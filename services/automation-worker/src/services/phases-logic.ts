// Pure phase-schedule logic — extracted from phases.service.ts so it's unit-testable
// (tests/unit/blueprints.phase-schedule.test.ts) without a DB. Same pattern as rules-logic.ts:
// `now` is injected so time-dependent behavior is deterministic under test.

export type PhaseDurationUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNIT_MS: Record<PhaseDurationUnit, number> = {
  seconds: SECOND,
  minutes: MINUTE,
  hours: HOUR,
  days: DAY,
  weeks: 7 * DAY,
  // Calendar months vary in length; a phase duration is already an approximation, so a fixed
  // 30-day month keeps the due-check predictable ("2 months" is always 60 days) rather than
  // depending on which months the phase happens to span. Same spirit as weeks being exactly 7 days.
  months: 30 * DAY,
};

/** Milliseconds a phase lasts, or null when it has no (valid) duration — i.e. it never elapses. */
export function phaseDurationMs(
  value: number | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = UNIT_MS[unit as PhaseDurationUnit];
  return ms === undefined ? null : value * ms;
}

export interface PhaseAdvanceInput {
  auto_advance: boolean;
  duration_value: number | null;
  duration_unit: string | null;
  /** When the instance entered its current phase. Null ⇒ never stamped, so nothing has elapsed. */
  phase_started_at: Date | null;
  /** False when the current phase is the last one — there is nowhere to advance to. */
  hasNextPhase: boolean;
}

/**
 * Whether an instance's current phase is due to roll over.
 *
 * Deliberately conservative: a phase advances only when it opted in (`auto_advance`), has a real
 * duration, has actually been entered, and something follows it. A blueprint whose last phase
 * auto-advances is not an error — it just stays there, which is what "steady state" means.
 */
export function isPhaseDue(input: PhaseAdvanceInput, now: Date = new Date()): boolean {
  if (!input.auto_advance || !input.hasNextPhase || !input.phase_started_at) return false;
  const durationMs = phaseDurationMs(input.duration_value, input.duration_unit);
  if (durationMs === null) return false;
  return now.getTime() - input.phase_started_at.getTime() >= durationMs;
}

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
