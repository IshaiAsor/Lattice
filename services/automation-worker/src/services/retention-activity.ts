import { formatKeep } from '@lattice/retention';
import { db } from '../db/client';
import type { KindCounters, PassCounters } from './retention.service';

// The worker's half of the retention audit trail (F18.19).
//
// The API records every configuration change; this records what the sweeps actually DID — which is
// the half that matters when someone asks where their data went. `retention_runs` already holds the
// counters, so these entries exist to put the sweep in the same one timeline as the change that
// caused it, and to carry the sentence rather than seven columns a person has to reassemble.
//
// Deliberately a small local writer rather than a shared package: the insert is a handful of
// fields, and the part that genuinely IS shared logic — turning a change into a sentence — lives in
// @lattice/retention, where both sides import it.

interface Entry {
  action: 'sweep_finished' | 'sweep_failed' | 'data_trimmed';
  scope: 'platform' | 'user';
  actorKind: 'user' | 'admin' | 'cron' | 'system';
  actorUserId: number | null;
  subjectUserId: number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  runId: number;
}

/**
 * Append one entry.
 *
 * **Never throws.** A sweep that deleted rows successfully must not be reported as failed because
 * its log line did not write — the run row is already the authority on the outcome. This is the one
 * place the "log in the same transaction" rule is relaxed, and only because the alternative is
 * worse: turning a successful destructive pass into a failure the operator then re-runs.
 */
export async function recordActivity(entry: Entry): Promise<void> {
  try {
    let actorName: string | null = entry.actorKind === 'cron' ? 'scheduled sweep' : null;
    if (entry.actorUserId !== null) {
      const u = await db.user.findUnique({
        where: { id: entry.actorUserId },
        select: { full_name: true, user_name: true, email: true },
      });
      actorName = u ? (u.full_name ?? u.user_name ?? u.email ?? null) : null;
    }
    await db.retentionActivity.create({
      data: {
        action: entry.action,
        scope: entry.scope,
        actor_kind: entry.actorKind,
        actor_user_id: entry.actorUserId,
        actor_name: actorName,
        subject_user_id: entry.subjectUserId,
        summary: entry.summary.slice(0, 400),
        before: entry.before === undefined ? undefined : (entry.before as object),
        after: entry.after === undefined ? undefined : (entry.after as object),
        run_id: entry.runId,
      },
    });
  } catch {
    // Swallowed on purpose — see above.
  }
}

/** "1,204 rows deleted, 812 buckets built across scalar, command" — the sweep in one line. */
export function summarizePass(counters: PassCounters): string {
  const kinds = Object.entries(counters) as [string, KindCounters][];
  const deleted = kinds.reduce((n, [, k]) => n + k.rowsDeleted, 0);
  const built = kinds.reduce((n, [, k]) => n + k.bucketsWritten, 0);
  const names = kinds
    .filter(([, k]) => k.rowsDeleted > 0 || k.bucketsWritten > 0)
    .map(([name]) => name)
    .join(', ');
  if (deleted === 0 && built === 0) return 'nothing to do — everything already within its windows';
  return `${deleted.toLocaleString('en-US')} rows deleted, ${built.toLocaleString('en-US')} buckets built${names ? ` across ${names}` : ''}`;
}

/**
 * Counters as JSON. `bytesReclaimed` is a bigint, which `JSON.stringify` throws on rather than
 * coercing — so it is rendered as a string here instead of losing precision through Number().
 */
export function countersForLog(counters: PassCounters): Record<string, unknown> {
  return Object.fromEntries(
    (Object.entries(counters) as [string, KindCounters][]).map(([kind, k]) => [
      kind,
      {
        bucketsWritten: k.bucketsWritten,
        rowsDeleted: k.rowsDeleted,
        bytesReclaimed: k.bytesReclaimed.toString(),
        bytesEstimated: k.bytesEstimated,
      },
    ]),
  );
}

/** Re-exported so callers phrase windows the same way the API does. */
export { formatKeep };
