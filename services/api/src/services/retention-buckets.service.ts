// The shared bucket vocabulary (F18.9): a catalog ANY user may add a size to, because a bucket
// is a unit rather than personal data. Two people who both want 90 minutes want the same 5400
// seconds, so they share one row - which is also what keeps a single FK target.

import {
  assertBucketAdmissible,
  badRequest,
  describeSeconds,
  formatSeconds,
} from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService } from './retention-activity.service';
import { MAX_CUSTOM_BUCKETS, bucketView } from './retention-tiers.shared';

export const retentionBucketsService = {
  // ── Bucket catalog ────────────────────────────────────────────────────────

  /** The vocabulary, finest first. Readable by any signed-in user — it is a list of durations. */
  async listBuckets() {
    const rows = await db.retentionBucket.findMany({
      orderBy: { seconds: 'asc' },
      include: { created_by: { select: { id: true, full_name: true, email: true } } },
    });
    return rows.map((r) => bucketView(r, r.created_by?.full_name ?? r.created_by?.email ?? null));
  },

  /**
   * Add a size. **Any user may** — a bucket is a unit, not personal data.
   *
   * A code that already exists resolves to the existing row rather than erroring: the user asked
   * for 90 minutes and gets 90 minutes, whoever created it. That is also what keeps the catalog a
   * single FK target instead of one row per person who wanted the same duration.
   */
  async createBucket(userId: number, body: Record<string, unknown>) {
    const seconds = Number(body['seconds']);
    assertBucketAdmissible(seconds);

    const existing = await db.retentionBucket.findFirst({ where: { seconds } });
    if (existing) {
      await retentionActivityService.record({
        action: 'bucket_reused',
        scope: 'catalog',
        actorKind: 'user',
        actorUserId: userId,
        subjectUserId: userId,
        subjectLabel: existing.code,
        summary: `asked for ${describeSeconds(seconds)} — resolved to the existing ${existing.code}`,
        after: { code: existing.code, seconds: existing.seconds },
      });
      return { ...bucketView(existing), reused: true };
    }

    // Refuse anything nobody would be allowed to use anyway, or the catalog fills with dead rows.
    const strictest = await db.retentionPolicy.findMany({ select: { min_bucket: true } });
    const floors = await db.retentionBucket.findMany({
      where: { code: { in: strictest.map((p) => p.min_bucket) } },
      select: { seconds: true },
    });
    const floor = Math.min(...floors.map((f) => f.seconds).filter((n) => n > 0), Infinity);
    if (Number.isFinite(floor) && seconds < floor)
      throw badRequest(
        `${describeSeconds(seconds)} is finer than the ${formatSeconds(floor)} minimum this platform allows`,
      );

    const custom = await db.retentionBucket.count({ where: { is_builtin: false } });
    if (custom >= MAX_CUSTOM_BUCKETS)
      throw badRequest(
        `This platform already has ${custom} custom bucket sizes, which is the limit — remove an unused one first.`,
      );

    const code =
      typeof body['code'] === 'string' && body['code'] ? body['code'] : formatSeconds(seconds);
    if (code.length > 12) throw badRequest('A bucket code may be at most 12 characters');
    const created = await db.$transaction(async (tx) => {
      const row = await tx.retentionBucket.create({
        data: {
          code,
          seconds,
          label:
            typeof body['label'] === 'string' && body['label']
              ? body['label']
              : describeSeconds(seconds),
          anchor_offset_seconds: 0,
          is_builtin: false,
          created_by_user_id: userId,
        },
      });
      await retentionActivityService.record(
        {
          action: 'bucket_created',
          scope: 'catalog',
          actorKind: 'user',
          actorUserId: userId,
          subjectUserId: userId,
          subjectLabel: row.code,
          summary: `added ${row.label} (${row.seconds}s) to the shared catalog`,
          after: { code: row.code, seconds: row.seconds, label: row.label },
        },
        tx,
      );
      return row;
    });
    // Same shape `listBuckets` returns. Both create paths used to hand back a raw Prisma row in
    // snake_case, which only worked because the caller happened to touch the two fields spelled
    // the same in both — `code` and `label`.
    return { ...bucketView(created), reused: false };
  },

  /**
   * Remove an unused custom size.
   *
   * "Unused" is two checks, not one. The FK covers tier rows; it says nothing about `sensor_rollup`
   * rows, which depend on the code without depending on it being *configured* — a bucket dropped
   * from every tier list still has history aggregated under it until the orphan sweep clears it.
   */
  async deleteBucket(userId: number, isAdmin: boolean, code: string) {
    const row = await db.retentionBucket.findUnique({ where: { code } });
    if (!row) throw Object.assign(new Error('Bucket not found'), { statusCode: 404 });
    if (row.is_builtin) throw badRequest(`${code} ships with the platform and cannot be removed`);
    if (!isAdmin && row.created_by_user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

    const [tiers, rollups] = await Promise.all([
      db.retentionPolicyTier
        .count({ where: { bucket: code } })
        .then(
          async (n) =>
            n +
            (await db.userRetentionTier.count({ where: { bucket: code } })) +
            (await db.deviceRetentionTier.count({ where: { bucket: code } })) +
            (await db.actionRetentionTier.count({ where: { bucket: code } })) +
            (await db.blueprintRetentionTier.count({ where: { bucket: code } })),
        ),
      db.sensorRollup.count({ where: { bucket: code } }),
    ]);
    if (tiers > 0)
      throw badRequest(`${code} is still in ${tiers} tier list${tiers === 1 ? '' : 's'}`);
    if (rollups > 0)
      throw badRequest(
        `${code} still has ${rollups} rollup rows stored under it — they are removed by the next sweep, then this can go.`,
      );
    await db.$transaction(async (tx) => {
      await tx.retentionBucket.delete({ where: { code } });
      // The row is about to stop existing, so this entry is the ONLY record that the size was ever
      // in the catalog, who added it and who removed it.
      await retentionActivityService.record(
        {
          action: 'bucket_deleted',
          scope: 'catalog',
          actorKind: isAdmin ? 'admin' : 'user',
          actorUserId: userId,
          subjectUserId: row.created_by_user_id,
          subjectLabel: row.code,
          summary: `removed ${row.label} (${row.seconds}s) from the shared catalog`,
          before: {
            code: row.code,
            seconds: row.seconds,
            label: row.label,
            createdByUserId: row.created_by_user_id,
            createdAt: row.created_at.toISOString(),
          },
        },
        tx,
      );
    });
  },
};
