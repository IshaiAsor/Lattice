import { Prisma } from '@lattice/prisma-client';
import { db } from '../db';

// The retention audit trail (F18.19) — when, who, what changed, and how.
//
// `retention_runs` records what a SWEEP did. This records everything else, and in particular the
// entire configuration half, which nothing recorded before: a tier row carries `updated_at`, which
// is current state rather than history. It can say a list changed this morning; it can never say
// who changed it, from what, or in which direction. For a feature whose whole purpose is deleting
// data irreversibly, that is the wrong side of the line.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. **A write is logged in the same transaction as the change it describes.** `record` takes the
//    transaction client so "the change committed but the log entry did not" cannot happen. An audit
//    trail that is written best-effort, after the fact, is one that is silently incomplete exactly
//    when something went wrong — which is the only time anybody reads it.
// 2. **Nothing here is ever updated or deleted.** Append-only. That is what keeps this table
//    separate from `retention_runs`, whose `phase` and `lock_key` are mutated throughout a run.

/** What happened. Kept as a closed union so the page can group and filter without string guesses. */
export type ActivityAction =
  | 'tiers_changed'
  | 'tiers_reset'
  | 'policy_changed'
  | 'bucket_created'
  | 'bucket_reused'
  | 'bucket_deleted'
  | 'sweep_requested'
  | 'sweep_finished'
  | 'sweep_failed'
  | 'data_trimmed';

/** Where it applied. */
export type ActivityScope = 'platform' | 'user' | 'device' | 'action' | 'blueprint' | 'catalog';

export interface ActivityEntry {
  action: ActivityAction;
  scope: ActivityScope;
  /** `user` and `admin` differ by authority, not by identity — an admin editing the platform list
   *  and a user editing their own are both `actor_user_id`, and only this tells them apart. */
  actorKind: 'user' | 'admin' | 'cron' | 'system';
  actorUserId: number | null;
  subjectUserId?: number | null;
  subjectRefId?: number | null;
  subjectLabel?: string | null;
  dataKind?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  runId?: number | null;
}

/** Anything with the Prisma model methods — the client or a transaction handle. */
type Client = Pick<typeof db, 'retentionActivity' | 'user'>;

const SUMMARY_MAX = 400;
const LABEL_MAX = 160;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function json(v: unknown): Prisma.InputJsonValue | undefined {
  return v === undefined ? undefined : (v as Prisma.InputJsonValue);
}

export const retentionActivityService = {
  /**
   * Append one entry.
   *
   * `client` defaults to the shared connection but should be the transaction handle whenever the
   * change itself is transactional — see rule 1 above.
   *
   * The actor's NAME is resolved and stored here rather than joined at read time. Both user FKs are
   * `SetNull`, so closing an account must neither be blocked by an audit row nor erase who acted:
   * the id goes, the name stays. A log that forgets who did something the moment their account
   * closes is not an audit trail.
   */
  async record(entry: ActivityEntry, client: Client = db): Promise<void> {
    let actorName: string | null = null;
    if (entry.actorUserId !== null) {
      const u = await client.user.findUnique({
        where: { id: entry.actorUserId },
        select: { full_name: true, email: true, user_name: true },
      });
      actorName = u ? (u.full_name ?? u.user_name ?? u.email ?? null) : null;
    } else if (entry.actorKind === 'cron') {
      actorName = 'scheduled sweep';
    }

    await client.retentionActivity.create({
      data: {
        action: entry.action,
        scope: entry.scope,
        actor_kind: entry.actorKind,
        actor_user_id: entry.actorUserId,
        actor_name: actorName,
        subject_user_id: entry.subjectUserId ?? null,
        subject_ref_id: entry.subjectRefId ?? null,
        subject_label: entry.subjectLabel ? clip(entry.subjectLabel, LABEL_MAX) : null,
        data_kind: entry.dataKind ?? null,
        summary: clip(entry.summary, SUMMARY_MAX),
        before: json(entry.before),
        after: json(entry.after),
        run_id: entry.runId ?? null,
      },
    });
  },

  /**
   * Read the trail.
   *
   * `viewerUserId` of `null` is the admin view — everything. Otherwise the filter is "my own
   * entries, plus platform-level ones", because a platform policy change is the ANSWER to "why did
   * my window move" and states nothing private: it is the same defaults and ceilings `mine()`
   * already returns. What it must never include is another user's `data_trimmed` entry, which
   * carries their data volumes — those all have a `subject_user_id`, so the filter excludes them.
   */
  async list(
    viewerUserId: number | null,
    opts: { action?: string; dataKind?: string; limit?: number; before?: number } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where: Prisma.RetentionActivityWhereInput = {
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.dataKind ? { data_kind: opts.dataKind } : {}),
      ...(opts.before ? { id: { lt: opts.before } } : {}),
      ...(viewerUserId === null
        ? {}
        : { OR: [{ subject_user_id: viewerUserId }, { scope: 'platform' }] }),
    };

    const rows = await db.retentionActivity.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: { subject_user: { select: { id: true, full_name: true, user_name: true } } },
    });

    const page = rows.slice(0, limit);
    return {
      entries: page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        action: r.action,
        scope: r.scope,
        actorKind: r.actor_kind,
        actorUserId: r.actor_user_id,
        // Falls back rather than showing an empty cell: a deleted actor is still a fact.
        actorName: r.actor_name ?? (r.actor_kind === 'cron' ? 'scheduled sweep' : 'a deleted user'),
        subjectUserId: r.subject_user_id,
        subjectUserName: r.subject_user
          ? (r.subject_user.full_name ?? r.subject_user.user_name)
          : null,
        subjectRefId: r.subject_ref_id,
        subjectLabel: r.subject_label,
        dataKind: r.data_kind,
        summary: r.summary,
        before: r.before,
        after: r.after,
        runId: r.run_id,
      })),
      // Cursor rather than an offset: the log only ever grows at the head, so an offset would
      // re-show rows as new entries land above it.
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  },
};
