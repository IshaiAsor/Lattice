// Pure threshold evaluation for pipeline sensor triggers — extracted from the telemetry
// consumer so it's unit-testable (tests/unit/threshold.test.ts) without pulling in DB/queue.

// A fault reading the device publishes when a sensor read fails: a JSON envelope
// {"error":"read_failed","action":"<name>"} on the normal telemetry topic. It is recorded
// to history (for error-duration queries — see SYSTEM-DESIGN-ROADMAP) but must NEVER be
// written as current_state or evaluated against a value threshold. This guard is the single
// place that recognizes one, so the telemetry consumer can branch before any value logic.
export interface ErrorReading {
  error: string;
  action?: string;
}

export function isErrorReading(value: unknown): value is ErrorReading {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['error'] === 'string'
  );
}

export function evaluateThreshold(value: unknown, operator: string, threshold: string): boolean {
  // A fault envelope is not a value — it can never satisfy a threshold.
  if (isErrorReading(value)) return false;
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
