import { createLogger } from '@lattice/logger';
import { Prisma } from '@lattice/prisma-client';
import {
  DATA_KINDS,
  RAW_SECONDS,
  dailyTierOf,
  pruneCutoff,
  type ResolvedTier,
} from '@lattice/retention';
import { db } from '../db/client';
import { env } from '../config/env.config';
import { kindEnabled, tiersForAction, tiersForUser, type TierIndex } from './tier-index';
import { deleteBounded } from './retention-delete';
import { COMMAND_BYTES, EVENT_BYTES, READING_BYTES, type PassCounters } from './retention-counters';

const log = createLogger('automation-worker:retention');

// ── Pruning ──────────────────────────────────────────────────────────────────

/** The raw tier of a resolved list, or null when the list is empty (= prune nothing). */
function rawTierOf(tiers: ResolvedTier[]): ResolvedTier | null {
  return tiers.find((t) => t.seconds === RAW_SECONDS) ?? null;
}

/**
 * Delete raw rows and rollup buckets past each scope's own window.
 *
 * Per user, not one global DELETE: the windows differ, and walking a user's own actions hits
 * `sensor_history(user_device_action_id, recorded_at)` and `device_commands(user_id,
 * dispatched_at)` head-on. A single time-only DELETE would match no index we have and seq-scan the
 * biggest tables in the system.
 *
 * Capped per kind per pass. Whatever is left over is deleted tomorrow — being a night late costs
 * nothing next to holding a lock over a million rows while rules are trying to evaluate.
 */
export async function pruneHistory(
  index: TierIndex,
  now: Date,
  scopeUserId: number | null,
  counters: PassCounters,
): Promise<void> {
  const cap = env.retention.deleteBatch;
  const users = await db.user.findMany({
    where: scopeUserId === null ? {} : { id: scopeUserId },
    select: { id: true },
  });

  for (const { id: userId } of users) {
    const actionIds = await db.userDeviceAction
      .findMany({ where: { user_device: { user_id: userId } }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));

    // ── scalar: raw rows, then every rollup tier on its own window ──
    if (kindEnabled(index, 'scalar')) {
      for (const actionId of actionIds) {
        const { tiers } = tiersForAction(index, actionId, 'scalar');
        // An empty list means nothing is configured anywhere — keep everything. Never the reverse.
        if (tiers.length === 0) continue;

        const raw = rawTierOf(tiers);
        const rawCut = raw ? pruneCutoff(raw.keepDays, true, now) : null;
        if (rawCut && counters.scalar.rowsDeleted < cap) {
          const n = await deleteBounded(
            'sensor_history',
            Prisma.sql`"user_device_action_id" = ${actionId} AND "recorded_at" < ${rawCut}`,
            cap - counters.scalar.rowsDeleted,
          );
          counters.scalar.rowsDeleted += n;
          counters.scalar.bytesReclaimed += BigInt(n) * READING_BYTES;
        }

        // Each rollup tier on its own window. F18.10: Phase 1 pruned NONE of these, so
        // `sensor_rollup` grew without bound whatever anyone configured — a retention UI wired to
        // nothing.
        for (const tier of tiers) {
          if (tier.seconds === RAW_SECONDS) continue;
          const cut = pruneCutoff(tier.keepDays, true, now);
          if (!cut || counters.scalar.rowsDeleted >= cap) continue;
          const n = await deleteBounded(
            'sensor_rollup',
            Prisma.sql`"user_device_action_id" = ${actionId} AND "bucket" = ${tier.bucket} AND "bucket_start" < ${cut}`,
            cap - counters.scalar.rowsDeleted,
          );
          counters.scalar.rowsDeleted += n;
        }

        // The orphan sweep. Without it, dropping a tier leaves its rows behind forever — and the
        // chart can still find them, so "I removed that granularity" silently means "I stopped
        // updating it" while the stale buckets keep being drawn.
        const configured = tiers.filter((t) => t.seconds !== RAW_SECONDS).map((t) => t.bucket);
        if (counters.scalar.rowsDeleted < cap) {
          const n = await deleteBounded(
            'sensor_rollup',
            configured.length > 0
              ? Prisma.sql`"user_device_action_id" = ${actionId} AND "bucket" NOT IN (${Prisma.join(configured)})`
              : Prisma.sql`"user_device_action_id" = ${actionId}`,
            cap - counters.scalar.rowsDeleted,
          );
          counters.scalar.rowsDeleted += n;
        }
      }
    }

    // ── frame: raw only, and the one kind whose bytes are MEASURED rather than estimated ──
    if (kindEnabled(index, 'frame')) {
      for (const actionId of actionIds) {
        const { tiers } = tiersForAction(index, actionId, 'frame');
        const raw = rawTierOf(tiers);
        const cut = raw ? pruneCutoff(raw.keepDays, true, now) : null;
        if (!cut || counters.frame.rowsDeleted >= cap) continue;
        // Sum the real bytes off the rows before they go — affordable only here, because
        // `byte_size` is already stored for the storage panel.
        const doomed = await db.cameraFrameHistory.aggregate({
          where: { user_device_action_id: actionId, recorded_at: { lt: cut } },
          _sum: { byte_size: true },
          _count: { _all: true },
        });
        const n = await deleteBounded(
          'camera_frame_history',
          Prisma.sql`"user_device_action_id" = ${actionId} AND "recorded_at" < ${cut}`,
          cap - counters.frame.rowsDeleted,
        );
        counters.frame.rowsDeleted += n;
        counters.frame.bytesEstimated = false;
        // Pro-rated when the cap cut the delete short, rather than claiming bytes still on disk.
        const total = doomed._count._all;
        const bytes = BigInt(doomed._sum.byte_size ?? 0);
        counters.frame.bytesReclaimed += total > 0 ? (bytes * BigInt(n)) / BigInt(total) : 0n;
      }
    }

    // ── command: user-scoped, indexed on (user_id, dispatched_at) ──
    if (kindEnabled(index, 'command')) {
      const { tiers } = tiersForUser(index, userId, 'command');
      const raw = rawTierOf(tiers);
      const cut = raw ? pruneCutoff(raw.keepDays, true, now) : null;
      if (cut && counters.command.rowsDeleted < cap) {
        const n = await deleteBounded(
          'device_commands',
          Prisma.sql`"user_id" = ${userId} AND "dispatched_at" < ${cut}`,
          cap - counters.command.rowsDeleted,
        );
        counters.command.rowsDeleted += n;
        counters.command.bytesReclaimed += BigInt(n) * COMMAND_BYTES;
      }
      // The daily rollup, on its governing tier's window — or swept away entirely when the list
      // has no whole-day tier at all (F18.23).
      //
      // This used to be `tiers.find((t) => t.seconds === 86_400)`, an exact match on one day, and
      // the two ways it missed both ended in the same place: rows written every night that nothing
      // would ever delete. `raw → 1w` is legal and offered by the editor but is not 86,400. `raw`
      // alone is what the Phase 2 migration produced for every user whose legacy `daily_days` was
      // NULL — a list nobody chose, which whole-list-wins then let shadow the platform's own `1d`.
      const daily = dailyTierOf(tiers);
      if (actionIds.length > 0 && counters.command.rowsDeleted < cap) {
        // Two different nulls, and conflating them is how this feature loses data or leaks it.
        // A MISSING tier means the list says nothing about daily summaries, so the rows are
        // orphans and all of them go. A `keepDays` of 0 means KEEP FOREVER, so none of them do.
        const where =
          daily === null
            ? Prisma.sql`"user_device_action_id" IN (${Prisma.join(actionIds)})`
            : (() => {
                const cut = pruneCutoff(daily.keepDays, true, now);
                return cut
                  ? Prisma.sql`"user_device_action_id" IN (${Prisma.join(actionIds)}) AND "day" < ${cut}`
                  : null;
              })();
        if (where) {
          const n = await deleteBounded(
            'command_rollup_daily',
            where,
            cap - counters.command.rowsDeleted,
          );
          counters.command.rowsDeleted += n;
        }
      }
    }

    // ── device_event: user-scoped, indexed on (user_id, recorded_at) ──
    if (kindEnabled(index, 'device_event')) {
      const { tiers } = tiersForUser(index, userId, 'device_event');
      const raw = rawTierOf(tiers);
      const cut = raw ? pruneCutoff(raw.keepDays, true, now) : null;
      if (cut && counters.device_event.rowsDeleted < cap) {
        const n = await deleteBounded(
          'device_events',
          Prisma.sql`"user_id" = ${userId} AND "recorded_at" < ${cut}`,
          cap - counters.device_event.rowsDeleted,
        );
        counters.device_event.rowsDeleted += n;
        counters.device_event.bytesReclaimed += BigInt(n) * EVENT_BYTES;
      }
      // Same rule, same two nulls — see the command branch above.
      const daily = dailyTierOf(tiers);
      if (counters.device_event.rowsDeleted < cap) {
        const deviceIds = await db.userDevice
          .findMany({ where: { user_id: userId }, select: { id: true } })
          .then((rows) => rows.map((r) => r.id));
        const cut = daily ? pruneCutoff(daily.keepDays, true, now) : null;
        const where =
          deviceIds.length === 0
            ? null
            : daily === null
              ? Prisma.sql`"user_device_id" IN (${Prisma.join(deviceIds)})`
              : cut
                ? Prisma.sql`"user_device_id" IN (${Prisma.join(deviceIds)}) AND "day" < ${cut}`
                : null;
        if (where) {
          const n = await deleteBounded(
            'device_availability_daily',
            where,
            cap - counters.device_event.rowsDeleted,
          );
          counters.device_event.rowsDeleted += n;
        }
      }
    }
  }

  log.info(
    Object.fromEntries(DATA_KINDS.map((k) => [k, counters[k].rowsDeleted])),
    'history prune complete',
  );
}
