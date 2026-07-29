// Pipeline sensor-threshold evaluation. Shared by automation-worker (the pipeline-trigger
// matcher) and digest-service (which only needs `isErrorReading` to keep fault telemetry out
// of current_state). Kept here beside `isPhaseInScope` — the two are the value gate and the
// phase gate of the same pipeline trigger, and a private copy in each service would drift.
//
// Pure — no I/O — so it's unit-testable without a database or a queue.

// A fault reading the device publishes when a sensor read fails: a JSON envelope
// {"error":"read_failed","action":"<name>"} on the normal telemetry topic. It is recorded to
// history (for error-duration queries — see SYSTEM-DESIGN-ROADMAP) but must NEVER be written as
// current_state or evaluated against a value threshold.
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

// Per-trigger cooldown gate. True while a trigger with this `minIntervalSec` is still within its
// cooldown window measured from `lastFiredAt`. A trigger that has never fired (null `lastFiredAt`)
// or has no interval is never in cooldown. Pure so the matcher's rate-limit is unit-testable.
export function isTriggerInCooldown(
  lastFiredAt: Date | null | undefined,
  minIntervalSec: number | null | undefined,
  now: Date,
): boolean {
  if (!minIntervalSec || !lastFiredAt) return false;
  return (now.getTime() - lastFiredAt.getTime()) / 1000 < minIntervalSec;
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
