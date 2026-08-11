// Positional values that may be written as a reference (F11.14).
//
// `target_state` and `threshold_value` have always been able to hold `@phase.x` — which is what
// lets one rule serve several lifecycles. The values *beside* them could not: how long the device
// holds the state, how long to wait first, and what time of day the schedule fires were plain
// integers and a VarChar(5) clock, read raw by the evaluators.
//
// That split is what forced the duplication it was meant to prevent. "Water for 60s" and "water
// for 180s" are the same rule with one number changed, so a blueprint serving three lifecycles
// carried three copies of it, and three more for lights-off at 20:00 / 22:00 / 18:00. The number
// belongs to the phase — it is a property of the growth stage, not of the automation — but there
// was nowhere to put it.
//
// So these columns take the same treatment `BlueprintPhase.duration_value` got in F11.13: text
// holding a literal *or* a reference, resolved per owner at evaluation time. Same three rules as
// there, deliberately:
//
//   * a literal keeps meaning exactly what it meant, so nothing already written changes;
//   * a reference resolves against the owner's own context, so one row answers differently per pot;
//   * anything unresolvable fails **closed** and says so, rather than guessing a number.
//
// Pure — no I/O — so the publish gate, all three evaluators and the unit tests share one definition.

import { isParamRef, resolveParam, type ParamContext } from './resolve';
import { minutesOfDay } from './schedule';

/** Postgres INTEGER ceiling. A resolved second-count above this is not a duration, it is a typo. */
const MAX_SECONDS = 2147483647;

/**
 * A stored second-count (a hold duration or a delay) as the number it means for this owner.
 *
 * Returns null for "no value", which each caller already has a meaning for: an absent duration is
 * "hold indefinitely" and an absent delay is "now". A reference that cannot be resolved returns
 * null too — the caller logs it and falls back to that same meaning, which is the pre-F11.14
 * behaviour rather than an invented number.
 *
 * Rejects negatives and non-finite values: a negative delay would mean "publish in the past" and a
 * negative duration would be sent to firmware that reads it as an unsigned count.
 */
export function resolveSeconds(
  value: string | number | null | undefined,
  ctx?: ParamContext | null,
): number | null {
  if (value === null || value === undefined) return null;

  let text: string;
  if (typeof value === 'number') {
    text = String(value);
  } else if (isParamRef(value)) {
    if (!ctx) return null;
    const resolved = resolveParam(value, ctx);
    if (resolved === null) return null;
    text = resolved;
  } else {
    text = value;
  }

  const n = Number(text.trim());
  if (!Number.isFinite(n) || n < 0 || n > MAX_SECONDS) return null;
  // Firmware counts whole seconds, and a fractional delay would round unpredictably per caller.
  return Math.floor(n);
}

/**
 * A stored clock time as the `HH:MM` it means for this owner.
 *
 * Fails closed to null, which `matchesSchedule` reads as "never fires". That is the safe direction:
 * a lighting rule whose off-time cannot be resolved should stay off the air rather than fire at
 * some default hour, because a light that never switches off is noticed and one that switches at
 * the wrong time looks deliberate.
 *
 * Normalises `7:30` to `07:30` so a resolved param written without the leading zero still matches —
 * `minutesOfDay` accepts both, but the value is also shown to people and compared as text.
 */
export function resolveClock(
  value: string | null | undefined,
  ctx?: ParamContext | null,
): string | null {
  if (!value) return null;

  let text = value;
  if (isParamRef(value)) {
    if (!ctx) return null;
    const resolved = resolveParam(value, ctx);
    if (resolved === null) return null;
    text = resolved;
  }

  const minutes = minutesOfDay(text);
  if (minutes === null) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * A positional value as the text the column stores.
 *
 * The wire shapes stayed permissive on purpose: an import document and the rule editor both send
 * `duration_seconds: 90` as a JSON number, and rewriting every caller to quote it would break
 * documents people already have. Numbers become their text, absent stays absent, and an empty
 * string is absent too — a cleared input in the builder means "no value", not the literal "".
 */
export function positionalText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : value.trim();
  return text === '' ? null : text;
}

/**
 * What is wrong with a positional value at publish time, or null when it is fine.
 *
 * References are not checked here beyond being well-formed — whether the key exists is
 * `validateParamRefs`'s job, which already runs over these positions. This catches the literal
 * that is simply not a value of its kind: "60s" in a seconds field, "8pm" in a clock field. Both
 * would otherwise publish clean and then fail closed forever at evaluation time, which is the
 * failure mode this whole gate exists to prevent.
 */
export function positionalError(
  value: string | number | null | undefined,
  kind: 'seconds' | 'clock',
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && isParamRef(value)) return null;

  if (kind === 'clock') {
    return minutesOfDay(String(value)) === null
      ? `"${String(value)}" is neither a HH:MM time nor a reference`
      : null;
  }

  const n = Number(String(value).trim());
  if (!Number.isFinite(n))
    return `"${String(value)}" is neither a number of seconds nor a reference`;
  if (n < 0) return `"${String(value)}" is negative`;
  if (n > MAX_SECONDS) return `"${String(value)}" is too large to store`;
  return null;
}
