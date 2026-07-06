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

// Schedule condition: HH:MM equality on the current minute; empty `days` = every day
// (days use JS getDay() numbering, 0 = Sunday).
export function matchesScheduleAt(
  time: string | null,
  days: number[],
  now: Date = new Date(),
): boolean {
  if (!time) return false;
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  if (`${hh}:${mm}` !== time) return false;
  if (!days || days.length === 0) return true;
  return days.includes(now.getDay());
}
