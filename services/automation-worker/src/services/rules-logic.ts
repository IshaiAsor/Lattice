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

/**
 * A condition's verdict plus the reading behind it. `observed` is what the condition actually saw
 * — the sensor's current_state, the device's online/offline — and exists so a fire can be recorded
 * with the value that caused it. A schedule condition observes nothing: it matched a clock, not a
 * reading, so it contributes `null` rather than a fabricated value.
 */
export type ConditionOutcome = { met: boolean; observed: string | null };

/** A rule's verdict plus the observed value worth recording on `user_rule_events`. */
export type RuleOutcome = { triggered: boolean; triggeredValue: string | null };

/**
 * Fold each condition's verdict into the rule's, and pick the reading to record with the fire.
 *
 * The value comes from a condition that actually PASSED. Under OR the rule fired because of that
 * condition and not the others, so a failing condition's reading would misreport why it fired;
 * under AND every condition passed anyway, so the first with something to say is representative.
 */
export function combineConditionOutcomes(
  operator: string,
  results: ConditionOutcome[],
): RuleOutcome {
  // An empty condition list is not a rule that always fires. `every` on [] is true, which would
  // make a conditionless AND rule fire on every single pass.
  if (results.length === 0) return { triggered: false, triggeredValue: null };
  const triggered = operator === 'AND' ? results.every((r) => r.met) : results.some((r) => r.met);
  const triggeredValue = triggered
    ? (results.find((r) => r.met && r.observed !== null)?.observed ?? null)
    : null;
  return { triggered, triggeredValue };
}
