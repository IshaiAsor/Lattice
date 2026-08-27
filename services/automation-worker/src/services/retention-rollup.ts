import { createLogger } from '@lattice/logger';
import {
  RAW_SECONDS,
  bucketStart,
  dayStart,
  emptyBucket,
  foldReading,
  foldRollup,
  bucketAvg,
  type Bucket,
  type ResolvedTier,
} from '@lattice/retention';
import { db } from '../db/client';
import { env } from '../config/env.config';
import { kindEnabled, tiersForAction, type TierIndex } from './tier-index';

const log = createLogger('automation-worker:retention');

// ── Rollups ──────────────────────────────────────────────────────────────────

/**
 * The window one tier is built over.
 *
 * `lookbackMs` is the pass's own reach — the full `RETENTION_LOOKBACK_DAYS` for a nightly pass, and
 * only the gap since the last one for an interval pass (F18.17). The per-tier floor below is what
 * keeps a narrow reach honest: whatever the pass asked for, a tier always sees the two buckets that
 * could still have changed.
 *
 * `until` is exclusive — the bucket we are currently inside is still filling, and a bucket written
 * now would be wrong by however much of it is left. Because the upsert is keyed on the bucket,
 * "wrong" would then persist until something recomputed it.
 *
 * The `2 × tierSeconds` term is not decoration. **Without it a `1w` tier is never built at all**
 * under the default 3-day lookback: `since` would land inside the current week, `until` at its
 * start, and the range would be empty every single night.
 */
function tierWindow(
  tier: ResolvedTier,
  now: Date,
  lookbackMs: number,
): { since: Date; until: Date } {
  const until = bucketStart(now, tier.seconds, tier.anchorOffsetSeconds);
  const span = Math.max(lookbackMs, 2 * tier.seconds * 1000);
  return { since: new Date(until.getTime() - span), until };
}

async function upsertRollup(
  actionId: number,
  bucket: string,
  bucketStartAt: Date,
  b: Bucket,
): Promise<void> {
  const data = {
    sample_count: b.sample_count,
    numeric_count: b.numeric_count,
    error_count: b.error_count,
    min_value: b.min_value,
    max_value: b.max_value,
    avg_value: bucketAvg(b),
    last_value: b.last_value,
  };
  await db.sensorRollup.upsert({
    where: {
      user_device_action_id_bucket_bucket_start: {
        user_device_action_id: actionId,
        bucket,
        bucket_start: bucketStartAt,
      },
    },
    create: { user_device_action_id: actionId, bucket, bucket_start: bucketStartAt, ...data },
    update: data,
  });
}

/**
 * Build every scalar rollup tier, ascending, each from the one below it.
 *
 * **Only the finest rollup tier reads `sensor_history`.** A `1w` tier built from raw would read a
 * week of 10-second readings per action per night; built from `1d` it reads seven rows. That is the
 * whole reason the tier list is sorted by size and the chain must divide — `foldRollup`
 * reconstructs a parent's average from its children's counts, so a `1d` bucket folded from hours
 * equals the one folded from the readings themselves.
 */
export async function rollUpScalars(
  index: TierIndex,
  now: Date,
  lookbackMs: number = env.retention.lookbackDays * 86_400_000,
): Promise<number> {
  if (!kindEnabled(index, 'scalar')) return 0;

  // Which actions have anything to roll up. One groupBy over the widest raw window serves every
  // tier that reads raw...
  const widest = new Date(now.getTime() - lookbackMs);
  const [rawActions, rollupActions] = await Promise.all([
    db.sensorHistory.groupBy({
      by: ['user_device_action_id'],
      where: { recorded_at: { gte: widest } },
      _count: { _all: true },
    }),
    // ...and this one covers the rest: a coarse tier is folded from finer ROLLUP rows, which exist
    // even on a night when no raw reading arrived. Without it a weekly bucket would never be built
    // for a sensor that went quiet.
    db.sensorRollup.groupBy({
      by: ['user_device_action_id'],
      where: { bucket_start: { gte: new Date(now.getTime() - 400 * 86_400_000) } },
      _count: { _all: true },
    }),
  ]);
  const actionIds = [
    ...new Set([
      ...rawActions.map((a) => a.user_device_action_id),
      ...rollupActions.map((a) => a.user_device_action_id),
    ]),
  ];
  if (actionIds.length === 0) return 0;

  let written = 0;
  for (const actionId of actionIds) {
    const { tiers } = tiersForAction(index, actionId, 'scalar');
    const rollupTiers = tiers.filter((t) => t.seconds !== RAW_SECONDS);
    if (rollupTiers.length === 0) continue;

    for (let i = 0; i < rollupTiers.length; i++) {
      const tier = rollupTiers[i]!;
      const source = i === 0 ? null : rollupTiers[i - 1]!;
      const { since, until } = tierWindow(tier, now, lookbackMs);
      const buckets = new Map<number, Bucket>();

      if (source === null) {
        // The finest rollup tier: the only one that touches raw.
        const rows = await db.sensorHistory.findMany({
          where: { user_device_action_id: actionId, recorded_at: { gte: since, lt: until } },
          orderBy: { recorded_at: 'asc' },
          select: { value: true, is_error: true, recorded_at: true },
          take: env.retention.rowsPerAction,
        });
        for (const r of rows) {
          const key = bucketStart(r.recorded_at, tier.seconds, tier.anchorOffsetSeconds).getTime();
          let acc = buckets.get(key);
          if (!acc) buckets.set(key, (acc = emptyBucket()));
          foldReading(acc, r.value, r.is_error);
        }
      } else {
        // Every coarser tier: folded from its predecessor's already-written rows.
        const rows = await db.sensorRollup.findMany({
          where: {
            user_device_action_id: actionId,
            bucket: source.bucket,
            bucket_start: { gte: since, lt: until },
          },
          orderBy: { bucket_start: 'asc' },
          select: {
            sample_count: true,
            numeric_count: true,
            error_count: true,
            min_value: true,
            max_value: true,
            avg_value: true,
            last_value: true,
            bucket_start: true,
          },
        });
        for (const r of rows) {
          const key = bucketStart(r.bucket_start, tier.seconds, tier.anchorOffsetSeconds).getTime();
          let acc = buckets.get(key);
          if (!acc) buckets.set(key, (acc = emptyBucket()));
          foldRollup(acc, r);
        }
      }

      for (const [startMs, b] of buckets) {
        await upsertRollup(actionId, tier.bucket, new Date(startMs), b);
        written += 1;
      }
    }
  }
  log.info({ buckets: written, actions: actionIds.length }, 'scalar rollup complete');
  return written;
}

/** Daily command counts per (action, source, outcome). */
export async function rollUpCommands(index: TierIndex, now: Date): Promise<number> {
  if (!kindEnabled(index, 'command')) return 0;
  const until = dayStart(now); // the current day is still open
  const since = new Date(until.getTime() - env.retention.lookbackDays * 86_400_000);

  const rows = await db.deviceCommand.findMany({
    where: {
      dispatched_at: { gte: since, lt: until },
      user_device_action_id: { not: null },
    },
    select: {
      user_device_action_id: true,
      source: true,
      status: true,
      dispatched_at: true,
    },
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.user_device_action_id}|${dayStart(r.dispatched_at).getTime()}|${r.source}|${r.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of counts) {
    const [actionId, dayMs, source, status] = key.split('|');
    const day = new Date(Number(dayMs));
    await db.commandRollupDaily.upsert({
      where: {
        user_device_action_id_day_source_status: {
          user_device_action_id: Number(actionId),
          day,
          source,
          status,
        },
      },
      create: { user_device_action_id: Number(actionId), day, source, status, count },
      update: { count },
    });
  }
  log.info({ buckets: counts.size }, 'command rollup complete');
  return counts.size;
}

/**
 * Daily uptime per device, from consecutive lifecycle events.
 *
 * Availability is the span BETWEEN events, so a day with no events at all is not a day with no
 * data — it is a full day in whatever state the device was already in. That is why the walk starts
 * from the last event *before* the window rather than from the first event inside it: otherwise
 * every quiet day would report zero seconds of everything.
 */
export async function rollUpAvailability(
  index: TierIndex,
  now: Date,
  scopeUserId: number | null,
): Promise<number> {
  if (!kindEnabled(index, 'device_event')) return 0;
  // Unlike the scalar and command rollups, this one DOES include the day in progress.
  //
  // Those two exclude the open period because a partial bucket is simply wrong — an average over
  // half an hour is not the hour's average, and the upsert would freeze that wrong number until
  // something recomputed it. Availability is different: "up 96% so far today" is a true and
  // useful statement, and because the row is recomputed from the events on every pass, it
  // self-corrects as the day fills in. Excluding it meant an outage this morning showed nothing
  // on the device page until tomorrow, which is precisely when someone goes looking.
  const until = now;
  const since = new Date(dayStart(now).getTime() - env.retention.lookbackDays * 86_400_000);

  const devices = await db.userDevice.findMany({
    where: scopeUserId === null ? {} : { user_id: scopeUserId },
    select: { id: true },
  });
  let written = 0;

  for (const { id: deviceId } of devices) {
    const [prior, events] = await Promise.all([
      db.deviceEvent.findFirst({
        where: {
          user_device_id: deviceId,
          kind: { in: ['online', 'offline'] },
          recorded_at: { lt: since },
        },
        orderBy: { recorded_at: 'desc' },
        select: { kind: true },
      }),
      db.deviceEvent.findMany({
        where: {
          user_device_id: deviceId,
          kind: { in: ['online', 'offline'] },
          recorded_at: { gte: since, lt: until },
        },
        orderBy: { recorded_at: 'asc' },
        select: { kind: true, recorded_at: true },
      }),
    ]);
    // Nothing ever recorded for this device: no rows rather than a fabricated 100% uptime.
    if (!prior && events.length === 0) continue;

    let state = prior ? prior.kind === 'online' : events[0]!.kind === 'offline';
    let cursor = since;
    const perDay = new Map<number, { on: number; off: number; t: number }>();
    const bump = (from: Date, to: Date, isOnline: boolean, transition: boolean) => {
      // Split the span at midnight so a two-day outage lands on both days.
      let a = from;
      while (a < to) {
        const dayEnd = new Date(dayStart(a).getTime() + 86_400_000);
        const b = to < dayEnd ? to : dayEnd;
        const key = dayStart(a).getTime();
        const acc = perDay.get(key) ?? { on: 0, off: 0, t: 0 };
        const secs = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
        if (isOnline) acc.on += secs;
        else acc.off += secs;
        perDay.set(key, acc);
        a = b;
      }
      if (transition) {
        const key = dayStart(to).getTime();
        const acc = perDay.get(key) ?? { on: 0, off: 0, t: 0 };
        acc.t += 1;
        perDay.set(key, acc);
      }
    };

    for (const e of events) {
      bump(cursor, e.recorded_at, state, true);
      state = e.kind === 'online';
      cursor = e.recorded_at;
    }
    bump(cursor, until, state, false);

    for (const [dayMs, acc] of perDay) {
      const day = new Date(dayMs);
      const data = { online_seconds: acc.on, offline_seconds: acc.off, transitions: acc.t };
      await db.deviceAvailabilityDaily.upsert({
        where: { user_device_id_day: { user_device_id: deviceId, day } },
        create: { user_device_id: deviceId, day, ...data },
        update: data,
      });
      written += 1;
    }
  }
  log.info({ days: written, devices: devices.length }, 'availability rollup complete');
  return written;
}
