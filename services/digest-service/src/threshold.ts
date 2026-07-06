// Pure threshold evaluation for pipeline sensor triggers — extracted from the telemetry
// consumer so it's unit-testable (tests/unit/threshold.test.ts) without pulling in DB/queue.

export function evaluateThreshold(value: unknown, operator: string, threshold: string): boolean {
  const v = parseFloat(String(value));
  const t = parseFloat(threshold);
  if (isNaN(v) || isNaN(t)) return String(value) === threshold;
  switch (operator) {
    case '>':
      return v > t;
    case '<':
      return v < t;
    case '>=':
      return v >= t;
    case '<=':
      return v <= t;
    case '=':
    case '==':
      return v === t;
    default:
      return false;
  }
}
