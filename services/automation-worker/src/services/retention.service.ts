import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { env } from '../config/env.config';
import {
  resolveRetention,
  pruneCutoff,
  hourStart,
  dayStart,
  emptyBucket,
  foldReading,
  bucketAvg,
  type Bucket,
  type DataKind,
  type EffectiveWindow,
  type PlatformPolicy,
} from './retention-logic';

const log = createLogger('automation-worker:retention');

// The nightly history pass (F18.1 / F6.5).
//
// Order is load-bearing: ROLL UP FIRST, PRUNE SECOND. A bucket is built by reading the raw rows it
// summarises, so pruning first would silently produce empty buckets for exactly the days a user
// asked to compress rather than lose. Everything here is idempotent — buckets upsert on their
// unique key — so a re-run, a missed night, or a crash halfway through self-heals on the next pass
// rather than double-counting.
//
// Batched and capped throughout. This shares a process with the 10s rules tick, and a delete over
// millions of rows holding a lock is how a history feature takes down automation.

const KINDS: DataKind[] = ['scalar', 'frame', 'command', 'device_event'];

/** Platform defaults keyed by kind, with a safe fallback if a row was deleted by hand. */
async function loadPolicies(): Promise<Map<string, PlatformPolicy>> {
  const rows = await db.retentionPolicy.findMany();
  const byKind = new Map<string, PlatformPolicy>(
    rows.map((r) => [r.data_kind, r as PlatformPolicy]),
  );
  for (const kind of KINDS) {
    if (!byKind.has(kind)) {
      // Missing row = keep everything. Never "delete everything": an absent policy is a
      // configuration accident, and the cost of guessing wrong is unrecoverable.
      log.warn({ kind }, 'no retention_policy row — treating as keep-forever');
      byKind.set(kind, {
        data_kind: kind,
        default_raw_days: 0,
        default_hourly_days: null,
        default_daily_days: null,
        max_raw_days: null,
        max_hourly_days: null,
        max_daily_days: null,
        enabled: false,
      });
    }
  }
  return byKind;
}

/** Every user's effective window per kind, resolved once per pass. */
async function loadWindows(): Promise<Map<number, Map<DataKind, EffectiveWindow>>> {
  const [policies, prefs, users] = await Promise.all([
    loadPolicies(),
    db.userRetentionPreference.findMany(),
    db.user.findMany({ select: { id: true } }),
  ]);
  const prefByUser = new Map<number, Map<string, (typeof prefs)[number]>>();
  for (const p of prefs) {
    let m = prefByUser.get(p.user_id);
    if (!m) prefByUser.set(p.user_id, (m = new Map()));
    m.set(p.data_kind, p);
  }
  const out = new Map<number, Map<DataKind, EffectiveWindow>>();
  for (const u of users) {
    const m = new Map<DataKind, EffectiveWindow>();
    for (const kind of KINDS) {
      m.set(kind, resolveRetention(policies.get(kind)!, prefByUser.get(u.id)?.get(kind)));
    }
    out.set(u.id, m);
  }
  return out;
}

// ── Rollups ──────────────────────────────────────────────────────────────────

/**
 * Fold raw scalar readings into hour and day buckets.
 *
 * Only COMPLETED periods are rolled up: the hour we are currently inside is still receiving
 * readings, and a bucket written now would be wrong by however much of the hour is left — and
 * because the upsert is keyed on the bucket, "wrong" would persist until something recomputed it.
 *
 * Bounded by `lookbackDays` rather than "everything not yet rolled up", so a first run against
 * years of history does not try to build every bucket in one pass. Successive nights walk backward
 * naturally because the upsert is idempotent.
 */
export async function rollUpScalars(now: Date): Promise<number> {
  const until = hourStart(now); // exclusive: the current hour is still open
  const since = new Date(until.getTime() - env.retention.lookbackDays * 86_400_000);

  const actions = await db.sensorHistory.groupBy({
    by: ['user_device_action_id'],
    where: { recorded_at: { gte: since, lt: until } },
    _count: { _all: true },
  });
  if (actions.length === 0) return 0;

  let written = 0;
  for (const { user_device_action_id: actionId } of actions) {
    // Ascending, so `last_value` is genuinely the last one in each bucket.
    const rows = await db.sensorHistory.findMany({
      where: { user_device_action_id: actionId, recorded_at: { gte: since, lt: until } },
      orderBy: { recorded_at: 'asc' },
      select: { value: true, is_error: true, recorded_at: true },
      take: env.retention.rowsPerAction,
    });

    const hours = new Map<number, Bucket>();
    const days = new Map<number, Bucket>();
    for (const r of rows) {
      const h = hourStart(r.recorded_at).getTime();
      const d = dayStart(r.recorded_at).getTime();
      if (!hours.has(h)) hours.set(h, emptyBucket());
      if (!days.has(d)) days.set(d, emptyBucket());
      foldReading(hours.get(h)!, r.value, r.is_error);
      foldReading(days.get(d)!, r.value, r.is_error);
    }

    for (const [bucket, map] of [
      ['hour', hours],
      ['day', days],
    ] as const) {
      for (const [startMs, b] of map) {
        const bucket_start = new Date(startMs);
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
              bucket_start,
            },
          },
          create: { user_device_action_id: actionId, bucket, bucket_start, ...data },
          update: data,
        });
        written += 1;
      }
    }
  }
  log.info({ buckets: written, actions: actions.length }, 'scalar rollup complete');
  return written;
}

/** Daily command counts per (action, source, outcome). */
export async function rollUpCommands(now: Date): Promise<number> {
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
export async function rollUpAvailability(now: Date): Promise<number> {
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

  const devices = await db.userDevice.findMany({ select: { id: true } });
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

// ── Pruning ──────────────────────────────────────────────────────────────────

/**
 * Delete raw rows past each user's own window.
 *
 * Per user, not one global DELETE: the windows differ, and walking a user's own actions hits
 * `sensor_history(user_device_action_id, recorded_at)` and `device_commands(user_id,
 * dispatched_at)` head-on. A single time-only DELETE would match no index we have and seq-scan the
 * biggest tables in the system.
 *
 * Capped per pass. Whatever is left over is deleted tomorrow — being a night late costs nothing
 * next to holding a lock over a million rows while rules are trying to evaluate.
 */
export async function pruneHistory(now: Date): Promise<Record<string, number>> {
  const windows = await loadWindows();
  const deleted: Record<string, number> = { scalar: 0, frame: 0, command: 0, device_event: 0 };
  const cap = env.retention.deleteBatch;

  for (const [userId, byKind] of windows) {
    const actionIds = await db.userDeviceAction
      .findMany({
        where: { user_device: { user_id: userId } },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));

    // scalar
    const scalar = byKind.get('scalar')!;
    const scalarCut = pruneCutoff(scalar.raw_days, scalar.enabled, now);
    if (scalarCut && actionIds.length > 0 && deleted.scalar! < cap) {
      const { count } = await db.sensorHistory.deleteMany({
        where: { user_device_action_id: { in: actionIds }, recorded_at: { lt: scalarCut } },
      });
      deleted.scalar! += count;
    }

    // frame
    const frame = byKind.get('frame')!;
    const frameCut = pruneCutoff(frame.raw_days, frame.enabled, now);
    if (frameCut && actionIds.length > 0 && deleted.frame! < cap) {
      const { count } = await db.cameraFrameHistory.deleteMany({
        where: { user_device_action_id: { in: actionIds }, recorded_at: { lt: frameCut } },
      });
      deleted.frame! += count;
    }

    // command — indexed on (user_id, dispatched_at), so this is a direct hit
    const command = byKind.get('command')!;
    const commandCut = pruneCutoff(command.raw_days, command.enabled, now);
    if (commandCut && deleted.command! < cap) {
      const { count } = await db.deviceCommand.deleteMany({
        where: { user_id: userId, dispatched_at: { lt: commandCut } },
      });
      deleted.command! += count;
    }

    // device_event — indexed on (user_id, recorded_at)
    const evt = byKind.get('device_event')!;
    const evtCut = pruneCutoff(evt.raw_days, evt.enabled, now);
    if (evtCut && deleted.device_event! < cap) {
      const { count } = await db.deviceEvent.deleteMany({
        where: { user_id: userId, recorded_at: { lt: evtCut } },
      });
      deleted.device_event! += count;
    }
  }

  log.info(deleted, 'history prune complete');
  return deleted;
}

/** The whole nightly pass. Roll up, then prune — never the other way round. */
export async function runRetentionPass(now: Date = new Date()): Promise<void> {
  const started = Date.now();
  try {
    await rollUpScalars(now);
    await rollUpCommands(now);
    await rollUpAvailability(now);
    await pruneHistory(now);
    log.info({ ms: Date.now() - started }, 'retention pass complete');
  } catch (err) {
    log.error({ err }, 'retention pass failed — will retry on the next schedule');
  }
}
