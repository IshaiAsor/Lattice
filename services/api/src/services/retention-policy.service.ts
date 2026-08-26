// The platform layer (F18.9/F18.11/F18.16): the default everyone starts on, and the ceiling
// nobody may exceed. Lowering a ceiling trims affected users at once and tells them - no grace
// period, because a grace period means knowingly storing data above the platform's own stated
// ceiling.

import {
  RAW_BUCKET,
  badRequest,
  diffTiers,
  formatCeiling,
  summarizeCeilingChanges,
  summarizeTierChanges,
  type DataKind,
  type Tier,
} from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService } from './retention-activity.service';
import { publish, RK } from '@lattice/queue';
import { getChannel } from '../queue';
import { KIND_LABELS, assertKind, parseTiers, validate, view } from './retention-tiers.shared';

export const retentionPolicyService = {
  // ── Platform layer (admin) ────────────────────────────────────────────────

  async listPolicies() {
    const rows = await db.retentionPolicy.findMany({
      orderBy: { data_kind: 'asc' },
      include: { tiers: { orderBy: { position: 'asc' } } },
    });
    return rows.map((p) => ({
      dataKind: p.data_kind,
      enabled: p.enabled,
      minBucket: p.min_bucket,
      updatedAt: p.updated_at.toISOString(),
      tiers: p.tiers.map((t) => ({ ...view(t), maxKeepDays: t.max_keep_days })),
    }));
  },

  /**
   * Replace the platform tier list for a kind.
   *
   * Lowering a ceiling here **trims affected users on the next sweep and notifies them** (F18.16) —
   * no grace period, because a grace period means knowingly storing data above the platform's own
   * stated ceiling. Which users are affected is computed here, while both the old and new ceilings
   * are still known.
   */
  async setPolicyTiers(adminId: number, kind: string, body: Record<string, unknown>) {
    assertKind(kind);
    const tiers = parseTiers(body);
    // The platform list is its own ceiling, so it is validated WITHOUT one — otherwise raising a
    // ceiling would be refused for exceeding the ceiling it is replacing.
    await validate(kind, tiers, { applyCeilings: false });

    const ceilings = new Map<string, number | null>();
    for (const t of (body['tiers'] as { bucket: string; maxKeepDays?: unknown }[]) ?? []) {
      const v = t.maxKeepDays;
      ceilings.set(t.bucket, v === null || v === undefined || v === '' ? null : Number(v));
    }
    for (const t of tiers) {
      const ceiling = ceilings.get(t.bucket) ?? null;
      if (ceiling !== null && (t.keepDays === 0 || t.keepDays > ceiling))
        throw badRequest(
          `The ${t.bucket} default (${t.keepDays === 0 ? 'forever' : `${t.keepDays} days`}) is above its own ceiling of ${ceiling} days`,
        );
    }

    const affected = await this.usersOverCeilings(kind, ceilings);

    await db.$transaction(async (tx) => {
      // Read before the delete, inside the transaction, so the logged pair is the pair that
      // applied rather than one another edit could have moved under us.
      const existing = await tx.retentionPolicyTier.findMany({
        where: { data_kind: kind },
        orderBy: { position: 'asc' },
      });
      const beforeTiers: Tier[] = existing.map((t) => ({
        bucket: t.bucket,
        keepDays: t.keep_days,
        position: t.position,
      }));
      const beforeCeilings = new Map(existing.map((t) => [t.bucket, t.max_keep_days]));

      await tx.retentionPolicyTier.deleteMany({ where: { data_kind: kind } });
      await tx.retentionPolicyTier.createMany({
        data: tiers.map((t) => ({
          data_kind: kind,
          bucket: t.bucket,
          keep_days: t.keepDays,
          max_keep_days: ceilings.get(t.bucket) ?? null,
          position: t.position,
          updated_by_user_id: adminId,
        })),
      });
      await tx.retentionPolicy.update({
        where: { data_kind: kind },
        data: {
          updated_by_user_id: adminId,
          ...(typeof body['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
          ...(typeof body['minBucket'] === 'string' ? { min_bucket: body['minBucket'] } : {}),
        },
      });

      // Defaults and ceilings are reported separately because they mean different things: a default
      // moves people who never customised, a ceiling BINDS everyone including those who did. An
      // entry that blurred them would hide the more consequential of the two.
      const parts = [
        summarizeTierChanges(diffTiers(beforeTiers, tiers)),
        summarizeCeilingChanges(beforeCeilings, ceilings),
      ].filter((x) => x && x !== 'no change');
      if (affected.length > 0)
        parts.push(
          `${affected.length} user${affected.length === 1 ? '' : 's'} over the new ceiling`,
        );

      if (parts.length > 0) {
        await retentionActivityService.record(
          {
            action: 'policy_changed',
            scope: 'platform',
            actorKind: 'admin',
            actorUserId: adminId,
            subjectUserId: null,
            dataKind: kind,
            summary: parts.join('; '),
            before: {
              tiers: beforeTiers,
              ceilings: Object.fromEntries(beforeCeilings),
            },
            after: {
              tiers,
              ceilings: Object.fromEntries(ceilings),
              affectedUserIds: affected.map((a) => a.userId),
            },
          },
          tx,
        );
      }
    });

    // F18.16 — after the write, because a notification about a change that then failed to commit is
    // worse than none. Best-effort: a notification that does not send must not fail the policy edit
    // an admin has already been told succeeded.
    if (affected.length > 0) {
      const label = KIND_LABELS[kind];
      // One entry per affected user, in addition to the platform entry above. The platform entry
      // says the ceiling moved; these say whose data it reached — and because they carry a
      // `subject_user_id`, each lands in that user's own feed and nobody else's.
      for (const a of affected) {
        await retentionActivityService
          .record({
            action: 'data_trimmed',
            scope: 'user',
            actorKind: 'admin',
            actorUserId: adminId,
            subjectUserId: a.userId,
            dataKind: kind,
            summary: a.trimmed
              .map(
                (t) =>
                  `${t.bucket} ${t.from === 0 ? 'forever' : `${t.from}d`} → ${formatCeiling(t.to)} (platform ceiling)`,
              )
              .join(', '),
            before: a.trimmed,
          })
          // The policy edit has already committed and the admin has been told it succeeded; a
          // failure to write one of these must not turn that into an error.
          .catch(() => undefined);
      }

      const ch = await getChannel().catch(() => null);
      if (ch) {
        for (const a of affected) {
          for (const t of a.trimmed) {
            publish(ch, RK.NOTIFICATION_SEND, {
              userId: String(a.userId),
              eventType: 'retention_trimmed',
              data: {
                dataKind: kind,
                dataKindLabel: label,
                bucketLabel: t.bucket === RAW_BUCKET ? 'raw readings window' : `${t.bucket} window`,
                previous: t.from === 0 ? 'forever' : `${t.from} days`,
                ceiling: String(t.to),
              },
            });
          }
        }
      }
    }

    return { policies: await this.listPolicies(), affected };
  },

  /**
   * Whose stored tiers would be trimmed by these ceilings (F18.16).
   *
   * Computed BEFORE the write, because afterwards the old ceiling is gone and "who was affected"
   * becomes unanswerable — the point of the notification is to tell someone their window changed,
   * which needs both numbers.
   */
  async usersOverCeilings(kind: DataKind, ceilings: Map<string, number | null>) {
    const capped = [...ceilings.entries()].filter(([, v]) => v !== null) as [string, number][];
    if (capped.length === 0) return [];
    const rows = await db.userRetentionTier.findMany({
      where: {
        data_kind: kind,
        OR: capped.map(([bucket, max]) => ({
          bucket,
          OR: [{ keep_days: 0 }, { keep_days: { gt: max } }],
        })),
      },
      select: { user_id: true, bucket: true, keep_days: true },
    });
    const byUser = new Map<number, { bucket: string; from: number; to: number }[]>();
    for (const r of rows) {
      const max = ceilings.get(r.bucket)!;
      const list = byUser.get(r.user_id) ?? [];
      list.push({ bucket: r.bucket, from: r.keep_days, to: max });
      byUser.set(r.user_id, list);
    }
    return [...byUser.entries()].map(([userId, trimmed]) => ({ userId, trimmed }));
  },
};
