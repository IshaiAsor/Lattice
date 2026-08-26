// The four stored scopes below the platform (F18.12): a user's own list, a device's, an
// action's, and what actually applies once they are resolved. The whole list wins from the most
// specific scope that has one - not a tier-by-tier merge, which would leave "removing it falls
// back to the device's" without a single answer.

import { DATA_KINDS, resolveTiers, type PlatformTier, type Tier } from '@lattice/retention';
import { db } from '../db';
import { ensureActionOwned, ensureDeviceOwned } from './ownership';
import { retentionActivityService } from './retention-activity.service';
import {
  assertKind,
  actionLabel,
  deviceLabel,
  loadCatalog,
  parseTiers,
  replaceActionTiers,
  replaceDeviceTiers,
  replaceUserTiers,
  validate,
  view,
} from './retention-tiers.shared';

export const retentionScopesService = {
  // ── User / device / action scopes ─────────────────────────────────────────

  /** One user's own list per kind, with what it resolves to and where that came from. */
  async mine(userId: number) {
    const [buckets, policies, userTiers] = await Promise.all([
      loadCatalog(),
      db.retentionPolicy.findMany({ include: { tiers: true } }),
      db.userRetentionTier.findMany({ where: { user_id: userId } }),
    ]);
    return DATA_KINDS.map((kind) => {
      const policy = policies.find((p) => p.data_kind === kind);
      const platform: PlatformTier[] =
        policy?.tiers.map((t) => ({
          bucket: t.bucket,
          keepDays: t.keep_days,
          maxKeepDays: t.max_keep_days,
          position: t.position,
        })) ?? [];
      const own = userTiers
        .filter((t) => t.data_kind === kind)
        .map((t) => ({ bucket: t.bucket, keepDays: t.keep_days, position: t.position }));
      const resolved = resolveTiers({
        kind,
        buckets,
        platform,
        user: own,
        minBucket: policy?.min_bucket ?? null,
      });
      return {
        dataKind: kind,
        // `overridden` is row PRESENCE, not a value comparison. A user who deliberately set 14 while
        // the default is also 14 has still made a choice, and must not be silently moved when the
        // default changes.
        overridden: own.length > 0,
        enabled: policy?.enabled ?? false,
        minBucket: policy?.min_bucket ?? 'raw',
        platformTiers: platform.map((t) => ({
          bucket: t.bucket,
          keepDays: t.keepDays,
          maxKeepDays: t.maxKeepDays,
          position: t.position,
        })),
        tiers: resolved.tiers,
        source: resolved.source,
        rejected: resolved.rejected,
      };
    });
  },

  async setMine(userId: number, kind: string, body: Record<string, unknown>) {
    assertKind(kind);
    const tiers = parseTiers(body);
    await validate(kind, tiers, { applyCeilings: true });
    await replaceUserTiers(userId, kind, tiers, {
      scope: 'user',
      actorKind: 'user',
      actorUserId: userId,
      subjectUserId: userId,
    });
    return this.mine(userId);
  },

  /**
   * Reset a kind to the platform list by DELETING the rows.
   *
   * Not by writing today's platform list into them: that would freeze the user at the current
   * values and quietly break the property that makes defaults worth having — that changing one
   * moves everyone who never customised.
   */
  async resetMine(userId: number, kind: string) {
    assertKind(kind);
    await db.$transaction(async (tx) => {
      const before = await tx.userRetentionTier.findMany({
        where: { user_id: userId, data_kind: kind },
        orderBy: { position: 'asc' },
      });
      const { count } = await tx.userRetentionTier.deleteMany({
        where: { user_id: userId, data_kind: kind },
      });
      // Only log if there was something to reset — a reset of nothing is not an event.
      if (count > 0) {
        await retentionActivityService.record(
          {
            action: 'tiers_reset',
            scope: 'user',
            actorKind: 'user',
            actorUserId: userId,
            subjectUserId: userId,
            dataKind: kind,
            summary: 'reset to the platform list',
            before: before.map((t) => ({
              bucket: t.bucket,
              keepDays: t.keep_days,
              position: t.position,
            })),
          },
          tx,
        );
      }
    });
    return this.mine(userId);
  },

  async deviceTiers(userId: number, deviceId: number, kind: string) {
    assertKind(kind);
    await ensureDeviceOwned(userId, deviceId);
    const rows = await db.deviceRetentionTier.findMany({
      where: { user_device_id: deviceId, data_kind: kind },
      orderBy: { position: 'asc' },
    });
    return rows.map(view);
  },

  async setDeviceTiers(
    userId: number,
    deviceId: number,
    kind: string,
    body: Record<string, unknown>,
  ) {
    assertKind(kind);
    await ensureDeviceOwned(userId, deviceId);
    const tiers = parseTiers(body);
    await validate(kind, tiers, { applyCeilings: true });
    await replaceDeviceTiers(deviceId, kind, tiers, {
      scope: 'device',
      actorKind: 'user',
      actorUserId: userId,
      subjectUserId: userId,
      subjectRefId: deviceId,
      subjectLabel: await deviceLabel(deviceId),
    });
    return this.deviceTiers(userId, deviceId, kind);
  },

  async clearDeviceTiers(userId: number, deviceId: number, kind: string) {
    assertKind(kind);
    await ensureDeviceOwned(userId, deviceId);
    const label = await deviceLabel(deviceId);
    await db.$transaction(async (tx) => {
      const before = await tx.deviceRetentionTier.findMany({
        where: { user_device_id: deviceId, data_kind: kind },
        orderBy: { position: 'asc' },
      });
      const { count } = await tx.deviceRetentionTier.deleteMany({
        where: { user_device_id: deviceId, data_kind: kind },
      });
      if (count > 0) {
        await retentionActivityService.record(
          {
            action: 'tiers_reset',
            scope: 'device',
            actorKind: 'user',
            actorUserId: userId,
            subjectUserId: userId,
            subjectRefId: deviceId,
            subjectLabel: label,
            dataKind: kind,
            summary: 'cleared — falls back to the wider scope',
            before: before.map((t) => ({
              bucket: t.bucket,
              keepDays: t.keep_days,
              position: t.position,
            })),
          },
          tx,
        );
      }
    });
  },

  async actionTiers(userId: number, actionId: number, kind: string) {
    assertKind(kind);
    await ensureActionOwned(userId, actionId);
    const rows = await db.actionRetentionTier.findMany({
      where: { user_device_action_id: actionId, data_kind: kind },
      orderBy: { position: 'asc' },
    });
    return rows.map(view);
  },

  async setActionTiers(
    userId: number,
    actionId: number,
    kind: string,
    body: Record<string, unknown>,
  ) {
    assertKind(kind);
    await ensureActionOwned(userId, actionId);
    const tiers = parseTiers(body);
    await validate(kind, tiers, { applyCeilings: true });
    await replaceActionTiers(actionId, kind, tiers, {
      scope: 'action',
      actorKind: 'user',
      actorUserId: userId,
      subjectUserId: userId,
      subjectRefId: actionId,
      subjectLabel: await actionLabel(actionId),
    });
    return this.actionTiers(userId, actionId, kind);
  },

  async clearActionTiers(userId: number, actionId: number, kind: string) {
    assertKind(kind);
    await ensureActionOwned(userId, actionId);
    const label = await actionLabel(actionId);
    await db.$transaction(async (tx) => {
      const before = await tx.actionRetentionTier.findMany({
        where: { user_device_action_id: actionId, data_kind: kind },
        orderBy: { position: 'asc' },
      });
      const { count } = await tx.actionRetentionTier.deleteMany({
        where: { user_device_action_id: actionId, data_kind: kind },
      });
      if (count > 0) {
        await retentionActivityService.record(
          {
            action: 'tiers_reset',
            scope: 'action',
            actorKind: 'user',
            actorUserId: userId,
            subjectUserId: userId,
            subjectRefId: actionId,
            subjectLabel: label,
            dataKind: kind,
            summary: 'cleared — falls back to the wider scope',
            before: before.map((t) => ({
              bucket: t.bucket,
              keepDays: t.keep_days,
              position: t.position,
            })),
          },
          tx,
        );
      }
    });
  },

  /** What actually applies to one action, and which scope decided it. */
  async effectiveForAction(userId: number, actionId: number, kind: string) {
    assertKind(kind);
    await ensureActionOwned(userId, actionId);
    const [buckets, policy, action] = await Promise.all([
      loadCatalog(),
      db.retentionPolicy.findUnique({ where: { data_kind: kind }, include: { tiers: true } }),
      db.userDeviceAction.findUniqueOrThrow({
        where: { id: actionId },
        select: {
          mqtt_action_name: true,
          user_device_id: true,
          user_device: {
            select: {
              user_id: true,
              blueprint_bindings: {
                select: { slot_key: true, instance: { select: { blueprint_id: true } } },
              },
            },
          },
        },
      }),
    ]);
    const binding = action.user_device.blueprint_bindings[0];
    const [own, device, blueprint, act] = await Promise.all([
      db.userRetentionTier.findMany({ where: { user_id: userId, data_kind: kind } }),
      db.deviceRetentionTier.findMany({
        where: { user_device_id: action.user_device_id, data_kind: kind },
      }),
      binding
        ? db.blueprintRetentionTier.findMany({
            where: {
              blueprint_id: binding.instance.blueprint_id,
              slot_key: binding.slot_key,
              action_name: action.mqtt_action_name,
              data_kind: kind,
            },
          })
        : Promise.resolve([]),
      db.actionRetentionTier.findMany({
        where: { user_device_action_id: actionId, data_kind: kind },
      }),
    ]);
    const toTier = (r: { bucket: string; keep_days: number; position: number }): Tier => ({
      bucket: r.bucket,
      keepDays: r.keep_days,
      position: r.position,
    });
    return resolveTiers({
      kind,
      buckets,
      platform:
        policy?.tiers.map((t) => ({
          bucket: t.bucket,
          keepDays: t.keep_days,
          maxKeepDays: t.max_keep_days,
          position: t.position,
        })) ?? [],
      user: own.map(toTier),
      device: device.map(toTier),
      blueprint: blueprint.map(toTier),
      action: act.map(toTier),
      minBucket: policy?.min_bucket ?? null,
    });
  },
};
