// Turning a change into a sentence (F18.19).
//
// The audit log stores `before`/`after` so a question nobody anticipated is still answerable, but a
// page of raw JSON pairs is not an audit trail anybody reads. This module produces the one-line
// summary that sits above them — "raw 30d → 7d, added 15m kept 90d, removed 1h".
//
// It lives in the package rather than in the API because both writers need it: `services/api` for
// every configuration change, and `services/automation-worker` for what a sweep did. That is the
// same rule that put the clamp here — Phase 1 grew a second copy of it in the API "for display
// only", and the two drifted.
//
// Pure: no database, no clock, no formatting locale. Given two lists it returns the same sentence
// every time, which is what makes it unit-testable and what keeps a log entry reproducible.

import type { Tier } from './tiers';

/** `0` means keep forever everywhere in this feature — never "delete immediately". */
export function formatKeep(days: number): string {
  if (days === 0) return 'forever';
  if (days % 365 === 0) return `${days / 365}y`;
  return `${days}d`;
}

/** A ceiling of `null` is UNCAPPED — a ceiling of 0 would read as "cap everyone at forever". */
export function formatCeiling(days: number | null): string {
  return days === null ? 'uncapped' : formatKeep(days);
}

export interface TierChange {
  bucket: string;
  kind: 'added' | 'removed' | 'changed';
  fromDays: number | null;
  toDays: number | null;
}

/**
 * What actually moved between two tier lists.
 *
 * Keyed by bucket rather than by position: reordering a list without changing any window is not a
 * retention change, and reporting it as one would bury the changes that matter. Position is
 * derived from bucket size at read time anyway.
 */
export function diffTiers(before: readonly Tier[], after: readonly Tier[]): TierChange[] {
  const b = new Map(before.map((t) => [t.bucket, t.keepDays]));
  const a = new Map(after.map((t) => [t.bucket, t.keepDays]));
  const changes: TierChange[] = [];

  for (const [bucket, toDays] of a) {
    const fromDays = b.get(bucket);
    if (fromDays === undefined) changes.push({ bucket, kind: 'added', fromDays: null, toDays });
    else if (fromDays !== toDays) changes.push({ bucket, kind: 'changed', fromDays, toDays });
  }
  for (const [bucket, fromDays] of b) {
    if (!a.has(bucket)) changes.push({ bucket, kind: 'removed', fromDays, toDays: null });
  }
  return changes;
}

/**
 * True when a change can only destroy data — a shortened window, or a tier removed outright.
 *
 * The audit page leads with these. Someone scanning a year of entries for "when did we start losing
 * the 15-minute data" needs the destructive changes to stand out from the harmless ones, and
 * "shorter" is not simply a smaller number: `0` is forever, so moving OFF `0` to any finite value
 * is a shortening however large it looks.
 */
export function isDestructive(c: TierChange): boolean {
  if (c.kind === 'removed') return true;
  if (c.kind === 'added') return false;
  if (c.fromDays === null || c.toDays === null) return false;
  if (c.fromDays === 0) return c.toDays !== 0; // forever → anything finite
  if (c.toDays === 0) return false; // anything → forever
  return c.toDays < c.fromDays;
}

/** One change as a phrase: "raw 30d → 7d", "added 15m kept 90d", "removed 1h". */
export function describeChange(c: TierChange): string {
  switch (c.kind) {
    case 'added':
      return `added ${c.bucket} kept ${formatKeep(c.toDays ?? 0)}`;
    case 'removed':
      return `removed ${c.bucket}`;
    default:
      return `${c.bucket} ${formatKeep(c.fromDays ?? 0)} → ${formatKeep(c.toDays ?? 0)}`;
  }
}

/**
 * The whole change as one line, capped so it always fits `retention_activity.summary`.
 *
 * Truncation counts the remainder rather than cutting mid-phrase, because "+3 more" is information
 * and a severed word is not. `before`/`after` hold the complete picture regardless.
 */
export function summarizeTierChanges(changes: readonly TierChange[], maxParts = 6): string {
  if (changes.length === 0) return 'no change';
  // Destructive first: that is what someone scanning the log is looking for.
  const ordered = [...changes].sort(
    (x, y) =>
      Number(isDestructive(y)) - Number(isDestructive(x)) || x.bucket.localeCompare(y.bucket),
  );
  const shown = ordered.slice(0, maxParts).map(describeChange);
  const rest = ordered.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
}

/** Ceiling moves, which only the platform list has. Reported separately — they bind every user. */
export function summarizeCeilingChanges(
  before: ReadonlyMap<string, number | null>,
  after: ReadonlyMap<string, number | null>,
): string {
  const parts: string[] = [];
  for (const [bucket, to] of after) {
    const from = before.has(bucket) ? (before.get(bucket) ?? null) : undefined;
    if (from === undefined || from === to) continue;
    parts.push(`${bucket} ceiling ${formatCeiling(from)} → ${formatCeiling(to)}`);
  }
  return parts.join(', ');
}

/**
 * True when a ceiling move can put existing users over the limit — the case F18.16 has to act on.
 *
 * `null` is uncapped and therefore the largest value, and `0` is forever: both read as "smaller"
 * to a naive comparison and neither is. Getting this backwards would either trim users who are
 * fine or silently leave users over a ceiling the platform has just declared, so it is written
 * once, here, rather than at each call site.
 */
export function ceilingLowered(from: number | null, to: number | null): boolean {
  if (to === null) return false; // now uncapped — nothing can be over it
  if (from === null) return true; // uncapped → capped binds everyone
  if (from === 0) return true; // forever → any finite cap
  if (to === 0) return false; // → forever is not a lowering
  return to < from;
}
