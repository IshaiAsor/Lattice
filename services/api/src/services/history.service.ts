import { db } from '../db';
import { resolveRange, clampLimit } from './history-bucket';
import { RAW_BUCKET, RAW_SECONDS, selectTier } from '@lattice/retention';
import { ensureActionOwned, ensureDeviceOwned } from './ownership';
import { retentionTiersService } from './retention-tiers.service';

// Read side of F18. Every query here is owner-scoped: history is the most personal data the
// platform holds, and an id in a URL is not proof of ownership.

export interface SeriesPoint {
  t: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
  errors: number;
  last: string | null;
}

export interface SeriesView {
  /**
   * The `retention_buckets.code` that answered — `raw`, `1h`, a user's custom `90m`, whatever is
   * configured. Surfaced so the chart can label a wide range as averaged rather than sampled.
   */
  bucket: string;
  from: string;
  to: string;
  points: SeriesPoint[];
  /**
   * Why this tier and not a finer one. `auto` is the normal ladder; `fallback` means everything
   * that could have answered has been pruned past this range, which is the difference between "the
   * device was off" and "those rows are gone" — and the chart has no way to tell them apart
   * otherwise.
   */
  reason: 'requested' | 'auto' | 'fallback';
}

/**
 * `detail` is deliberately `unknown` rather than Prisma's JsonValue: naming that type here drags a
 * path into `@lattice/prisma-client/node_modules/.prisma/client/runtime` into this module's public
 * type, which does not resolve from any other package. The shape is per-kind anyway, so a caller
 * has to narrow it whatever we call it.
 */
export interface DeviceEventView {
  id: number;
  kind: string;
  from: string | null;
  to: string | null;
  detail: unknown;
  at: string;
}

export const historyService = {
  /**
   * A reading series over a range.
   *
   * Raw rows and rollup buckets are different shapes answering the same question, so both are
   * mapped to one point shape rather than making the client branch. A raw point has count 1 and no
   * min/max spread — that is honest, not missing data: a single reading has no range.
   */
  async series(
    userId: number,
    actionId: number,
    query: { from?: unknown; to?: unknown; bucket?: unknown },
  ): Promise<SeriesView> {
    await ensureActionOwned(userId, actionId);
    const { from, to } = resolveRange(query.from, query.to);

    // The candidate set is DATA (F18.9): whatever tiers actually resolve for this action, at
    // whichever scope configured them. That is what makes "an admin adds a 15m tier and the chart
    // uses it" true without a release — and, just as importantly, stops the chart asking for a
    // bucket the orphan sweep has legitimately removed because nobody configures it any more.
    const { tiers } = await retentionTiersService.effectiveForAction(userId, actionId, 'scalar');
    const picked = selectTier(tiers, from, to, {
      requested: typeof query.bucket === 'string' ? query.bucket : null,
    });
    // No tiers configured anywhere means nothing is pruned either, so raw is both available and
    // the only honest answer.
    const bucket = picked?.bucket ?? RAW_BUCKET;
    const reason = picked?.source ?? 'auto';

    if (picked === null || picked.seconds === RAW_SECONDS) {
      const rows = await db.sensorHistory.findMany({
        where: { user_device_action_id: actionId, recorded_at: { gte: from, lte: to } },
        orderBy: { recorded_at: 'asc' },
        select: { value: true, is_error: true, recorded_at: true },
        // A hard ceiling even on raw: 48h of 10-second readings is 17k points, and no chart can
        // draw them. Better to return the window's worth than to stream a payload nobody plots.
        take: 5000,
      });
      return {
        bucket,
        reason,
        from: from.toISOString(),
        to: to.toISOString(),
        points: rows.map((r) => {
          const n = r.value === null || r.value.trim() === '' ? NaN : Number(r.value);
          const numeric = Number.isFinite(n) ? n : null;
          return {
            t: r.recorded_at.toISOString(),
            avg: numeric,
            min: numeric,
            max: numeric,
            count: 1,
            errors: r.is_error ? 1 : 0,
            last: r.value,
          };
        }),
      };
    }

    const rows = await db.sensorRollup.findMany({
      where: {
        user_device_action_id: actionId,
        bucket,
        bucket_start: { gte: from, lte: to },
      },
      orderBy: { bucket_start: 'asc' },
      select: {
        bucket_start: true,
        avg_value: true,
        min_value: true,
        max_value: true,
        sample_count: true,
        error_count: true,
        last_value: true,
      },
    });
    return {
      bucket,
      reason,
      from: from.toISOString(),
      to: to.toISOString(),
      points: rows.map((r) => ({
        t: r.bucket_start.toISOString(),
        avg: r.avg_value,
        min: r.min_value,
        max: r.max_value,
        count: r.sample_count,
        errors: r.error_count,
        last: r.last_value,
      })),
    };
  },

  /**
   * Frame METADATA for a range — never the frames themselves.
   *
   * Returning N base64 JPEGs in one response is the single thing that would make "keep every
   * frame" unusable: a hundred thumbnails is 4 MB of JSON. The gallery pages this list and asks
   * for each image by id only when it is actually shown.
   */
  async frames(
    userId: number,
    actionId: number,
    query: { from?: unknown; to?: unknown; limit?: unknown; before?: unknown },
  ) {
    await ensureActionOwned(userId, actionId);
    const { from, to } = resolveRange(query.from, query.to);
    const before = Number(query.before);
    const rows = await db.cameraFrameHistory.findMany({
      where: {
        user_device_action_id: actionId,
        recorded_at: { gte: from, lte: to },
        ...(Number.isFinite(before) && before > 0 ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: clampLimit(query.limit, 60, 200),
      select: { id: true, byte_size: true, recorded_at: true },
    });
    const total = await db.cameraFrameHistory.count({
      where: { user_device_action_id: actionId },
    });
    return {
      total,
      frames: rows.map((r) => ({
        id: r.id,
        bytes: r.byte_size,
        capturedAt: r.recorded_at.toISOString(),
      })),
    };
  },

  /** One frame, by id. Ownership is checked through the action the frame hangs off. */
  async frame(userId: number, frameId: number) {
    const row = await db.cameraFrameHistory.findUnique({
      where: { id: frameId },
      select: {
        value: true,
        recorded_at: true,
        user_device_action: { select: { user_device: { select: { user_id: true } } } },
      },
    });
    if (!row) throw Object.assign(new Error('Frame not found'), { statusCode: 404 });
    if (row.user_device_action.user_device.user_id !== userId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return { frame: row.value, capturedAt: row.recorded_at.toISOString() };
  },

  /** A device's own timeline: online/offline, firmware, faults. */
  async deviceEvents(
    userId: number,
    deviceId: number,
    query: { from?: unknown; to?: unknown; kind?: unknown; limit?: unknown },
  ): Promise<DeviceEventView[]> {
    await ensureDeviceOwned(userId, deviceId);
    const { from, to } = resolveRange(query.from, query.to);
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : undefined;
    const rows = await db.deviceEvent.findMany({
      where: {
        user_device_id: deviceId,
        recorded_at: { gte: from, lte: to },
        ...(kind ? { kind } : {}),
      },
      orderBy: { recorded_at: 'desc' },
      take: clampLimit(query.limit, 100),
      select: {
        id: true,
        kind: true,
        from_value: true,
        to_value: true,
        detail: true,
        recorded_at: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      from: r.from_value,
      to: r.to_value,
      detail: r.detail,
      at: r.recorded_at.toISOString(),
    }));
  },

  /** Daily uptime bands for the availability strip. */
  async availability(userId: number, deviceId: number, query: { from?: unknown; to?: unknown }) {
    await ensureDeviceOwned(userId, deviceId);
    const { from, to } = resolveRange(query.from, query.to, new Date(), 30);
    const rows = await db.deviceAvailabilityDaily.findMany({
      where: { user_device_id: deviceId, day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
      select: { day: true, online_seconds: true, offline_seconds: true, transitions: true },
    });
    const on = rows.reduce((a, r) => a + r.online_seconds, 0);
    const off = rows.reduce((a, r) => a + r.offline_seconds, 0);
    return {
      // Null rather than 0% when nothing has been recorded: "we do not know yet" and "it was down
      // all week" must not look the same on a dashboard.
      uptimePercent: on + off === 0 ? null : Number(((on / (on + off)) * 100).toFixed(1)),
      days: rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        onlineSeconds: r.online_seconds,
        offlineSeconds: r.offline_seconds,
        transitions: r.transitions,
      })),
    };
  },

  /**
   * The command feed — the whole-home "what did my home do" list.
   *
   * Deliberately not device-scoped: the question that needed this ("why did the pump run at 3am")
   * is asked before you know which device to look at. `deviceId` narrows it for the device page,
   * which is the same feed filtered rather than a second implementation.
   */
  async commands(
    userId: number,
    query: {
      deviceId?: unknown;
      actionId?: unknown;
      source?: unknown;
      status?: unknown;
      from?: unknown;
      to?: unknown;
      limit?: unknown;
      before?: unknown;
    },
  ) {
    const { from, to } = resolveRange(query.from, query.to);
    const deviceId = Number(query.deviceId);
    const actionId = Number(query.actionId);
    const before = Number(query.before);
    const limit = clampLimit(query.limit);

    const rows = await db.deviceCommand.findMany({
      where: {
        // user_id, not a join: device_commands is indexed on (user_id, dispatched_at), which is
        // exactly this query.
        user_id: userId,
        dispatched_at: { gte: from, lte: to },
        ...(Number.isFinite(deviceId) && deviceId > 0 ? { user_device_id: deviceId } : {}),
        ...(Number.isFinite(actionId) && actionId > 0 ? { user_device_action_id: actionId } : {}),
        ...(typeof query.source === 'string' && query.source ? { source: query.source } : {}),
        ...(typeof query.status === 'string' && query.status ? { status: query.status } : {}),
        ...(Number.isFinite(before) && before > 0 ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        action_name: true,
        target_state: true,
        duration_seconds: true,
        source: true,
        source_label: true,
        status: true,
        result_value: true,
        dispatched_at: true,
        settled_at: true,
        user_device: { select: { id: true, name: true } },
        user_device_action_id: true,
      },
    });

    return {
      commands: rows.map((r) => ({
        id: r.id,
        deviceId: r.user_device?.id ?? null,
        deviceName: r.user_device?.name ?? null,
        actionId: r.user_device_action_id,
        actionName: r.action_name,
        target: r.target_state,
        durationSeconds: r.duration_seconds,
        source: r.source,
        sourceLabel: r.source_label,
        status: r.status,
        result: r.result_value,
        dispatchedAt: r.dispatched_at.toISOString(),
        settledAt: r.settled_at?.toISOString() ?? null,
      })),
      // The cursor the client sends back as ?before= — same shape as notifications.listHistory.
      nextBefore: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  },

  /** Headline counters for the dashboard stat row. */
  async summary(userId: number, query: { from?: unknown; to?: unknown }) {
    const { from, to } = resolveRange(query.from, query.to);
    const [total, failed, devices, online] = await Promise.all([
      db.deviceCommand.count({ where: { user_id: userId, dispatched_at: { gte: from, lte: to } } }),
      db.deviceCommand.count({
        where: {
          user_id: userId,
          dispatched_at: { gte: from, lte: to },
          status: { in: ['error', 'timeout'] },
        },
      }),
      db.userDevice.count({ where: { user_id: userId } }),
      db.userDevice.count({ where: { user_id: userId, online: true } }),
    ]);
    return { commands: total, failed, devices, online };
  },
};
