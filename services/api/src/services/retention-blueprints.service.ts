// Blueprint tiers (F18.12), addressed by (blueprint_id, slot_key, action_name) so a blueprint
// can single out its known-noisy sensor without touching the switches beside it.
//
// Admin-only: a user cannot edit the definition their instance inherits.

import { diffTiers, summarizeTierChanges, type Tier } from '@lattice/retention';
import { db } from '../db';
import { retentionActivityService } from './retention-activity.service';
import { assertKind, parseTiers, validate, view } from './retention-tiers.shared';

export const retentionBlueprintsService = {
  // ── Blueprint scope (admin only) ──────────────────────────────────────────
  //
  // A user cannot edit the definition their instance inherits; they override it at their own device
  // or action scope, which sits above blueprint in the resolution order.

  async blueprintTiers(blueprintId: number) {
    const rows = await db.blueprintRetentionTier.findMany({
      where: { blueprint_id: blueprintId },
      orderBy: [{ slot_key: 'asc' }, { action_name: 'asc' }, { position: 'asc' }],
    });
    return rows.map((r) => ({
      slotKey: r.slot_key,
      actionName: r.action_name,
      dataKind: r.data_kind,
      ...view(r),
    }));
  },

  async setBlueprintTiers(
    blueprintId: number,
    slotKey: string,
    actionName: string,
    kind: string,
    body: Record<string, unknown>,
    adminId: number,
  ) {
    assertKind(kind);
    const tiers = parseTiers(body);
    await validate(kind, tiers, { applyCeilings: true });
    const bp = await db.blueprint.findUnique({
      where: { id: blueprintId },
      select: { name: true },
    });
    await db.$transaction(async (tx) => {
      const existing = await tx.blueprintRetentionTier.findMany({
        where: {
          blueprint_id: blueprintId,
          slot_key: slotKey,
          action_name: actionName,
          data_kind: kind,
        },
        orderBy: { position: 'asc' },
      });
      const before: Tier[] = existing.map((t) => ({
        bucket: t.bucket,
        keepDays: t.keep_days,
        position: t.position,
      }));

      await tx.blueprintRetentionTier.deleteMany({
        where: {
          blueprint_id: blueprintId,
          slot_key: slotKey,
          action_name: actionName,
          data_kind: kind,
        },
      });
      if (tiers.length > 0) {
        await tx.blueprintRetentionTier.createMany({
          data: tiers.map((t) => ({
            blueprint_id: blueprintId,
            slot_key: slotKey,
            action_name: actionName,
            data_kind: kind,
            bucket: t.bucket,
            keep_days: t.keepDays,
            position: t.position,
          })),
        });
      }

      const changes = diffTiers(before, tiers);
      if (changes.length > 0) {
        await retentionActivityService.record(
          {
            action: 'tiers_changed',
            scope: 'blueprint',
            actorKind: 'admin',
            actorUserId: adminId,
            // No subject user: a blueprint tier is inherited by every instance, so it belongs to
            // nobody in particular and must not land in one user's feed.
            subjectUserId: null,
            subjectRefId: blueprintId,
            subjectLabel: `${bp?.name ?? `blueprint ${blueprintId}`} · ${slotKey} · ${actionName}`,
            dataKind: kind,
            summary: summarizeTierChanges(changes),
            before,
            after: tiers,
          },
          tx,
        );
      }
    });
    return this.blueprintTiers(blueprintId);
  },
};
