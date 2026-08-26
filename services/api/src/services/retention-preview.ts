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
  const [bucketRows, policies, users, userTiers, deviceTiers, actionTiers, actions] =
    await Promise.all([
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
        select: { id: true, user_device_id: true, user_device: { select: { user_id: true } } },
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

  const group = <T extends { data_kind: string }>(list: T[], key: (r: T) => number) => {
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

  // Per-action kinds. Blueprint tiers are deliberately not consulted here: a preview that differed
  // from the sweep would be worse than no preview, but blueprint tiers only ever sit BELOW device
  // and action in the order, and a user who has neither is on the platform list either way. The
  // sweep's own resolution is authoritative; this is the number shown before confirming.
  for (const a of actions) {
    for (const kind of ['scalar', 'frame'] as const) {
      if (!enabledFor(kind)) continue;
      const { tiers } = resolveTiers({
        kind,
        buckets,
        platform: platformFor(kind),
        user: byUser.get(`${a.user_device.user_id}|${kind}`)?.map(toTier),
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
