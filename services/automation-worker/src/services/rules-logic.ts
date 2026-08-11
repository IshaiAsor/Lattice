// Pure rule-evaluation logic — extracted from rules.engine.ts so it's unit-testable
// (tests/unit/automation.rules-logic.test.ts) without pulling in DB/queue. The engine
// injects `now` so time-dependent behavior is deterministic under test.

export function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    default:
      return false;
  }
}

export function isCooldownExpired(
  lastTriggered: Date | null,
  cooldownSeconds: number,
  now: Date = new Date(),
): boolean {
  if (!lastTriggered) return true;
  const elapsed = (now.getTime() - lastTriggered.getTime()) / 1000;
  return elapsed >= cooldownSeconds;
}

// The schedule matcher used to live here. It moved to `@lattice/params` (schedule.ts) when the
// window shape landed, because the pipeline-trigger scan needs exactly the same evaluator and the
// API needs exactly the same validator — one definition of what a schedule is, or they drift.
export { matchesSchedule } from '@lattice/params';
export type { ScheduleSpec } from '@lattice/params';
