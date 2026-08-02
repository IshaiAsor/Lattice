// Phase timing (F10.12). How long an instance has been in a phase, and whether that phase is due
// to roll over. Shared — like isPhaseInScope and resolveParam — because two callers must agree on
// it exactly: automation-worker decides *when the cron fires*, and api renders *the countdown the
// user reads*. If they used two definitions of "elapsed", the page would show a deadline that
// isn't the one the clock keeps.
//
// The model has two halves and only the first is stored:
//
//   accrued   — seconds banked from PREVIOUS visits, written when the instance leaves a phase
//               (blueprint_instance_phase_state.accrued_seconds)
//   live run  — now - blueprint_instances.phase_started_at, computed at read time
//
// Keeping the live run out of the database is what lets a timer run without a single write, and
// keeping the bank in it is what lets a rolled-back phase resume instead of restarting.
//
// `now` is injected everywhere so time-dependent behaviour stays deterministic under test.

export type PhaseDurationUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNIT_SECONDS: Record<PhaseDurationUnit, number> = {
  seconds: 1,
  minutes: MINUTE,
  hours: HOUR,
  days: DAY,
  weeks: 7 * DAY,
  // Calendar months vary in length; a phase duration is already an approximation, so a fixed
  // 30-day month keeps the due-check predictable ("2 months" is always 60 days) rather than
  // depending on which months the phase happens to span. Same spirit as weeks being exactly 7 days.
  months: 30 * DAY,
};

/** What the user chose to do with the bank of the phase being entered. */
export type PhaseTimerMode = 'reset' | 'resume' | 'at';

/** Postgres INTEGER ceiling — the cap on any stored or requested second count. */
export const MAX_ACCRUED_SECONDS = 2147483647;

/** Seconds a phase lasts, or null when it has no (valid) duration — i.e. it never elapses. */
export function phaseDurationSeconds(
  value: number | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const seconds = UNIT_SECONDS[unit as PhaseDurationUnit];
  return seconds === undefined ? null : value * seconds;
}

/**
 * Whole seconds from `from` to `to`, floored and never negative.
 *
 * The floor at zero is not paranoia: `phase_started_at` is written by whichever service performed
 * the transition, so a clock stepping backwards (or a stamp briefly in the future) would otherwise
 * bank a negative and silently *credit* a phase with time it never spent.
 */
export function secondsBetween(from: Date, to: Date): number {
  const delta = Math.floor((to.getTime() - from.getTime()) / 1000);
  return delta > 0 ? delta : 0;
}

/**
 * The one definition of "how long has this instance been in this phase": banked time plus the
 * visit currently running. `startedAt` is null for any phase the instance is not in right now, in
 * which case the bank is the whole answer.
 */
export function phaseElapsedSeconds(
  accruedSeconds: number,
  startedAt: Date | null | undefined,
  now: Date = new Date(),
): number {
  const accrued = Number.isFinite(accruedSeconds) && accruedSeconds > 0 ? accruedSeconds : 0;
  return accrued + (startedAt ? secondsBetween(startedAt, now) : 0);
}

/**
 * What the bank of the phase being *entered* becomes. The phase being left always banks its run
 * regardless of this — the two are orthogonal, which is what makes "roll back, then forward again"
 * behave without special-casing the direction of the move.
 */
export function accruedOnEnter(
  mode: PhaseTimerMode,
  existingSeconds: number,
  requestedSeconds = 0,
): number {
  const clamp = (n: number): number =>
    !Number.isFinite(n) || n < 0 ? 0 : Math.min(Math.floor(n), MAX_ACCRUED_SECONDS);
  if (mode === 'resume') return clamp(existingSeconds);
  if (mode === 'at') return clamp(requestedSeconds);
  return 0;
}

export interface PhaseAdvanceInput {
  auto_advance: boolean;
  duration_value: number | null;
  duration_unit: string | null;
  /** When the instance entered its current phase. Null ⇒ never stamped, so nothing has elapsed. */
  phase_started_at: Date | null;
  /** Banked from earlier visits. A resumed phase is already part-way through its duration. */
  accrued_seconds: number;
  /** False when the current phase is the last one — there is nowhere to advance to. */
  hasNextPhase: boolean;
}

/**
 * Whether an instance's current phase is due to roll over.
 *
 * Deliberately conservative: a phase advances only when it opted in (`auto_advance`), has a real
 * duration, has actually been entered, and something follows it. A blueprint whose last phase
 * auto-advances is not an error — it just stays there, which is what "steady state" means.
 *
 * Banked time counts, so resuming a phase 3 days in makes an 11-day remainder, not a fresh 14. A
 * user who resumes *past* the duration is warned by the UI and then taken at their word here: the
 * phase is due immediately and the next tick moves it on.
 */
export function isPhaseDue(input: PhaseAdvanceInput, now: Date = new Date()): boolean {
  if (!input.auto_advance || !input.hasNextPhase || !input.phase_started_at) return false;
  const durationSeconds = phaseDurationSeconds(input.duration_value, input.duration_unit);
  if (durationSeconds === null) return false;
  return phaseElapsedSeconds(input.accrued_seconds, input.phase_started_at, now) >= durationSeconds;
}
