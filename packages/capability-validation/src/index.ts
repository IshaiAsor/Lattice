// Validates a command value against a GoogleDeviceTrait.valid_parameters constraint (or the
// union of several — see deriveValidParameters below) — one shared implementation so
// digest-service and google-home don't each reimplement the rule.

export interface EnumConstraint {
  type: 'enum';
  values: string[];
}

export interface RangeConstraint {
  type: 'range';
  min: number;
  max: number;
  step?: number;
  aliases?: string[]; // extra accepted string values alongside the numeric range (e.g. "on"/"off")
}

export interface PatternConstraint {
  type: 'pattern';
  regex: string;
}

export type ValidParameters = EnumConstraint | RangeConstraint | PatternConstraint;

// `constraint` is untyped because it comes straight off a Prisma `Json?` column — validate
// its shape at the call site, not the caller's. Unrecognized/malformed constraints fail
// open (return true): bad catalog data shouldn't brick command dispatch, only a properly
// declared, recognized constraint blocks a value.
export function validateValue(value: string, constraint: unknown): boolean {
  if (constraint === null || constraint === undefined || typeof constraint !== 'object')
    return true;

  const type = (constraint as { type?: unknown }).type;
  switch (type) {
    case 'enum': {
      const { values } = constraint as EnumConstraint;
      return Array.isArray(values) && values.includes(value);
    }
    case 'range': {
      const { min, max, step, aliases } = constraint as RangeConstraint;
      if (Array.isArray(aliases) && aliases.includes(value)) return true;
      const num = Number(value);
      if (!Number.isFinite(num) || num < min || num > max) return false;
      const s = step && step > 0 ? step : 1;
      const steps = (num - min) / s;
      return Math.abs(steps - Math.round(steps)) < 1e-9;
    }
    case 'pattern': {
      const { regex } = constraint as PatternConstraint;
      if (typeof regex !== 'string') return true;
      try {
        return new RegExp(regex).test(value);
      } catch {
        return true; // malformed regex in catalog data — fail open
      }
    }
    default:
      return true;
  }
}

function asConstraint(value: unknown): ValidParameters | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  return type === 'enum' || type === 'range' || type === 'pattern'
    ? (value as ValidParameters)
    : null;
}

// A capability's actual accepted values are the union of every trait it declares — accepted
// values are a trait/protocol property (OnOff is always on/off, Brightness is always 0-100),
// not a per-capability one, so there's no separate capability-level authoring; this just
// combines what's already on the linked traits. Pass e.g.
// `capability.traits.map(t => t.google_trait.valid_parameters)`.
//
// Merge rule: at most one numeric range is meaningful, so if any range constraint is present,
// it wins and every enum's values are folded into its `aliases` (e.g. OnOff + Brightness on the
// same capability → range 0-100 with aliases ["on","off"]). Otherwise all enums are unioned
// into one. Patterns are rare and not merged — the first one found is used.
export function deriveValidParameters(traitConstraints: unknown[]): ValidParameters | undefined {
  const parsed = traitConstraints.map(asConstraint).filter((c): c is ValidParameters => c !== null);
  if (parsed.length === 0) return undefined;

  const ranges = parsed.filter((c): c is RangeConstraint => c.type === 'range');
  const enums = parsed.filter((c): c is EnumConstraint => c.type === 'enum');
  const patterns = parsed.filter((c): c is PatternConstraint => c.type === 'pattern');

  if (ranges.length > 0) {
    const [base] = ranges;
    const aliases = new Set(base.aliases ?? []);
    for (const e of enums) for (const v of e.values) aliases.add(v);
    return aliases.size > 0 ? { ...base, aliases: [...aliases] } : base;
  }
  if (enums.length > 0) {
    const values = new Set<string>();
    for (const e of enums) for (const v of e.values) values.add(v);
    return { type: 'enum', values: [...values] };
  }
  return patterns[0];
}

// Firmware version comparison for sealed-device templates (vX.Y.Z range matching).
export * from './version';
