import { releasedTemplateFor } from '@lattice/capability-validation';
import {
  DATA_KINDS,
  RAW_SECONDS,
  pruneCutoff,
  resolveTiers,
  type BucketDef,
  type DataKind,
  type PlatformTier,
  type Tier,
} from '@lattice/retention';
import { db } from '../db';

// "What will this delete?" — counted, not estimated (F18.13).
//
// The confirmation dialog names real numbers or it is decoration: "this is irreversible" above a
// spinner teaches people to click through it. So this runs the same resolution the sweep runs and
// COUNTs instead of DELETEing.
//
// It lives in `api` rather than in the worker even though the worker already loads a tier index,
// because the answer has to come back inside the request that asks for it — a preview delivered by
// queue arrives after the dialog it was for has closed. The part that must not drift is the
// resolution, and that is `resolveTiers` in @lattice/retention, which both call.

export interface SweepPreview {
  /** Rows that would go, per kind. */
  rows: Record<DataKind, number>;
  /** Measured for frames (byte_size is stored); estimated elsewhere, and labelled as such. */
  bytes: Record<DataKind, number>;
  bytesEstimated: Record<DataKind, boolean>;
}

// The same per-row constants the storage panel and the worker use, so the three figures agree.
const READING_BYTES = 48;
const COMMAND_BYTES = 180;
const EVENT_BYTES = 120;

const toTier = (r: { bucket: string; keep_days: number; position: number }): Tier => ({
  bucket: r.bucket,
  keepDays: r.keep_days,
  position: r.position,
});

/**
 * Count what a sweep would remove.
 *
 * `scopeUserId` null = the whole platform (admin). Never taken from a request body — the user route
 * passes `req.user!.id` positionally.
 */
export async function previewSweep(
  scopeUserId: number | null,
  now: Date = new Date(),
): Promise<SweepPreview> {
  const userWhere = scopeUserId === null ? {} : { user_id: scopeUserId };
  const [
    bucketRows,
    policies,
    users,
    userTiers,
    deviceTiers,
    actionTiers,
    actions,
    blueprintTiers,
    bindings,
    sealedTiers,
    sealedCatalog,
    releasedTargets,
  ] = await Promise.all([
    db.retentionBucket.findMany(),
    db.retentionPolicy.findMany({ include: { tiers: true } }),
    db.user.findMany({
      where: scopeUserId === null ? {} : { id: scopeUserId },
      select: { id: true },
    }),
    db.userRetentionTier.findMany({ where: userWhere }),
    db.deviceRetentionTier.findMany({
      where: scopeUserId === null ? {} : { user_device: { user_id: scopeUserId } },
    }),
    db.actionRetentionTier.findMany({
      where:
        scopeUserId === null
          ? {}
          : { user_device_action: { user_device: { user_id: scopeUserId } } },
    }),
    db.userDeviceAction.findMany({
      where: scopeUserId === null ? {} : { user_device: { user_id: scopeUserId } },
      select: {
        id: true,
        mqtt_action_name: true,
        user_device_id: true,
        user_device: { select: { user_id: true, device_type_id: true } },
      },
    }),
    // The two admin-authored scopes. Never narrowed by user — they are definitions every matching
    // device inherits — exactly as the worker's `loadTierIndex` loads them.
    db.blueprintRetentionTier.findMany(),
    db.blueprintSlotBinding.findMany({
      where: scopeUserId === null ? {} : { user_device: { user_id: scopeUserId } },
      select: {
        user_device_id: true,
        slot_key: true,
        instance: { select: { blueprint_id: true } },
      },
    }),
    db.sealedRetentionTier.findMany(),
    db.device.findMany({
      where: { is_sealed: true },
      select: { id: true, type: true, version: true },
    }),
    db.sealedTemplateTarget.findMany({
      where: { template: { status: 'released' } },
      select: { template_id: true, device_type: true, version_min: true, version_max: true },
    }),
  ]);

  const buckets = new Map<string, BucketDef>(
    bucketRows.map((b) => [
      b.code,
      {
        code: b.code,
        seconds: b.seconds,
        label: b.label,
        anchorOffsetSeconds: b.anchor_offset_seconds,
      },
    ]),
  );

  const rows: Record<DataKind, number> = { scalar: 0, frame: 0, command: 0, device_event: 0 };
  const bytes: Record<DataKind, number> = { scalar: 0, frame: 0, command: 0, device_event: 0 };
  const bytesEstimated: Record<DataKind, boolean> = {
    scalar: true,
    frame: false,
    command: true,
    device_event: true,
  };

  const platformFor = (kind: DataKind): PlatformTier[] =>
    policies
      .find((p) => p.data_kind === kind)
      ?.tiers.map((t) => ({
        bucket: t.bucket,
        keepDays: t.keep_days,
        maxKeepDays: t.max_keep_days,
        position: t.position,
      })) ?? [];
  const minBucketFor = (kind: DataKind) =>
    policies.find((p) => p.data_kind === kind)?.min_bucket ?? null;
  const enabledFor = (kind: DataKind) =>
    policies.find((p) => p.data_kind === kind)?.enabled ?? false;

  const group = <T extends { data_kind: string }>(list: T[], key: (r: T) => number | string) => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const k = `${key(r)}|${r.data_kind}`;
      const at = m.get(k);
      if (at) at.push(r);
      else m.set(k, [r]);
    }
    return m;
  };
  const byUser = group(userTiers, (r) => r.user_id);
  const byDevice = group(deviceTiers, (r) => r.user_device_id);
  const byAction = group(actionTiers, (r) => r.user_device_action_id);
  const byBlueprintSlot = group(
    blueprintTiers,
    (r) => `${r.blueprint_id}\u0000${r.slot_key}\u0000${r.action_name}`,
  );
  const bySealedEntry = group(sealedTiers, (r) => `${r.sealed_template_id}\u0000${r.action_name}`);
  const deviceSlot = new Map(
    bindings.map((b) => [b.user_device_id, `${b.instance.blueprint_id}\u0000${b.slot_key}`]),
  );
  const catalogTemplate = new Map<number, number>();
  for (const d of sealedCatalog) {
    const templateId = releasedTemplateFor(d.type, d.version, releasedTargets);
    if (templateId !== null) catalogTemplate.set(d.id, templateId);
  }

  // Per-action kinds, resolved through EVERY scope the sweep resolves through. A preview that
  // differed from the sweep would be worse than no preview. Blueprint tiers were once skipped here on
  // the grounds that they sit below device and action — but they also sit ABOVE user and platform, so
  // any device bound to a blueprint with tiers was previewed on the wrong list. Sealed (F18.21) has
  // the same shape and is loaded the same way.
  for (const a of actions) {
    const slot = deviceSlot.get(a.user_device_id);
    const templateId = catalogTemplate.get(a.user_device.device_type_id);
    for (const kind of ['scalar', 'frame'] as const) {
      if (!enabledFor(kind)) continue;
      const { tiers } = resolveTiers({
        kind,
        buckets,
        platform: platformFor(kind),
        user: byUser.get(`${a.user_device.user_id}|${kind}`)?.map(toTier),
        sealed:
          templateId === undefined
            ? undefined
            : bySealedEntry.get(`${templateId}\u0000${a.mqtt_action_name}|${kind}`)?.map(toTier),
        blueprint:
          slot === undefined
            ? undefined
            : byBlueprintSlot.get(`${slot}\u0000${a.mqtt_action_name}|${kind}`)?.map(toTier),
        device: byDevice.get(`${a.user_device_id}|${kind}`)?.map(toTier),
        action: byAction.get(`${a.id}|${kind}`)?.map(toTier),
        minBucket: minBucketFor(kind),
      });
      const raw = tiers.find((t) => t.seconds === RAW_SECONDS);
      const cut = raw ? pruneCutoff(raw.keepDays, true, now) : null;
      if (!cut) continue;

      if (kind === 'scalar') {
        const n = await db.sensorHistory.count({
          where: { user_device_action_id: a.id, recorded_at: { lt: cut } },
        });
        rows.scalar += n;
        bytes.scalar += n * READING_BYTES;
      } else {
        const agg = await db.cameraFrameHistory.aggregate({
          where: { user_device_action_id: a.id, recorded_at: { lt: cut } },
          _sum: { byte_size: true },
          _count: { _all: true },
        });
        rows.frame += agg._count._all;
        bytes.frame += agg._sum.byte_size ?? 0;
      }
    }
  }

  // User-scoped kinds. `device_commands.user_id` and `device_events.user_id` are what the prune
  // indexes hit, so these windows are the user's, not an action's — consulting a device or action
  // tier here would let a per-sensor row silently change a window applied user-wide.
  for (const u of users) {
    for (const kind of ['command', 'device_event'] as const) {
      if (!enabledFor(kind)) continue;
      const { tiers } = resolveTiers({
        kind,
        buckets,
        platform: platformFor(kind),
        user: byUser.get(`${u.id}|${kind}`)?.map(toTier),
        minBucket: minBucketFor(kind),
      });
      const raw = tiers.find((t) => t.seconds === RAW_SECONDS);
      const cut = raw ? pruneCutoff(raw.keepDays, true, now) : null;
      if (!cut) continue;
      if (kind === 'command') {
        const n = await db.deviceCommand.count({
          where: { user_id: u.id, dispatched_at: { lt: cut } },
        });
        rows.command += n;
        bytes.command += n * COMMAND_BYTES;
      } else {
        const n = await db.deviceEvent.count({
          where: { user_id: u.id, recorded_at: { lt: cut } },
        });
        rows.device_event += n;
        bytes.device_event += n * EVENT_BYTES;
      }
    }
  }

  // A kind with nothing to delete has nothing measured either — reporting "0 bytes (measured)" for
  // frames nobody has is true but reads as a failure.
  for (const kind of DATA_KINDS) {
    if (rows[kind] === 0) bytesEstimated[kind] = true;
  }

  return { rows, bytes, bytesEstimated };
}
