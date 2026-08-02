// Phase timer formatting (F10.12), shared by the instance page and the phase-change dialog so a
// duration reads the same wherever it appears.
//
// The unit table matches @lattice/params' phaseDurationSeconds exactly — including the fixed
// 30-day month. The backoffice is its own npm project and cannot import the workspace package, so
// this is a deliberate mirror; the API already sends `duration_seconds` pre-converted, and this
// table exists only for the *input* side (the "start at 2 days" control).

export const PHASE_UNITS = [
  { key: 'seconds', label: 'seconds', seconds: 1 },
  { key: 'minutes', label: 'minutes', seconds: 60 },
  { key: 'hours', label: 'hours', seconds: 3600 },
  { key: 'days', label: 'days', seconds: 86400 },
  { key: 'weeks', label: 'weeks', seconds: 604800 },
  { key: 'months', label: 'months', seconds: 2592000 },
] as const;

/**
 * A duration as the two largest units that carry information — "3d 4h", "5m 20s", "45s".
 *
 * Two units rather than all of them: on a day-scale phase the minutes are noise, and on a
 * minute-scale one the days are absent anyway. Zero is "0s" rather than empty, because a timer
 * that has just been reset should read as running, not as missing.
 */
/** 0–100 for a progress bar. A phase past its duration reads full rather than overflowing. */
export function progressPercent(elapsedSeconds: number, durationSeconds: number | null): number {
  if (!durationSeconds) return 0;
  return Math.min(100, (elapsedSeconds / durationSeconds) * 100);
}

/** Seconds left before an auto-advance, or null when the phase has no limit. */
export function remainingSeconds(
  elapsedSeconds: number,
  durationSeconds: number | null,
): number | null {
  if (durationSeconds === null) return null;
  return Math.max(0, durationSeconds - elapsedSeconds);
}

/**
 * What the phase the setup is *in* reads: "1d left", "due to advance", or — for a phase with no
 * limit, where "how long have I been here" is still the question — "in this phase 3d 4h".
 *
 * A **paused** setup reports elapsed instead of remaining. "23h 59m left" on a clock that is not
 * running is a promise the page cannot keep: nothing is counting down, and the number would still
 * read the same tomorrow.
 *
 * Shared by the instance page and the setups list so one clock cannot be described two ways.
 */
export function currentPhaseTimerLabel(
  elapsedSeconds: number,
  durationSeconds: number | null,
  running = true,
): string {
  if (!running) return `${formatDuration(elapsedSeconds)} in, paused`;
  const left = remainingSeconds(elapsedSeconds, durationSeconds);
  if (left === null) return `in this phase ${formatDuration(elapsedSeconds)}`;
  return left > 0 ? `${formatDuration(left)} left` : 'due to advance';
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds === 0) return '0s';

  const parts: { value: number; suffix: string }[] = [
    { value: Math.floor(seconds / 86400), suffix: 'd' },
    { value: Math.floor((seconds % 86400) / 3600), suffix: 'h' },
    { value: Math.floor((seconds % 3600) / 60), suffix: 'm' },
    { value: seconds % 60, suffix: 's' },
  ];
  const firstSet = parts.findIndex((p) => p.value > 0);
  return parts
    .slice(firstSet, firstSet + 2)
    .filter((p) => p.value > 0)
    .map((p) => `${p.value}${p.suffix}`)
    .join(' ');
}
