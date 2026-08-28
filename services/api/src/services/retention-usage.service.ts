import {
  AVAILABILITY_BYTES,
  COMMAND_BYTES,
  COMMAND_ROLLUP_BYTES,
  EVENT_BYTES,
  RAW_BUCKET,
  READING_BYTES,
  ROLLUP_BYTES,
  sumUsage,
  type KindUsage,
  type UsageBucket,
} from '@lattice/retention';
import { db } from '../db';

// How much history is actually stored — for one user, or platform-wide, broken down by bucket.
//
// This is all that survives of the Phase 1 `retention.service.ts`. That file also carried the
// platform defaults, a user's overrides and the admin "overridden by" table, every one of them
// reading `retention_policy`'s six day columns or `user_retention_preferences`. F18.9 moved the
// windows into the tier tables and F18.19 gave the changes an audit trail, which left those methods
// answering from columns nothing writes any more — a screen showing values that are not what runs
// is worse than no screen. They are gone, and with them the last reader of the legacy columns, so
// the contract migration that drops them is now unblocked.
//
// Usage stayed because it was never about the config: it counts rows.
//
// **It counted the wrong ones until F18.22.** Only the four RAW tables were included, so every row
// retention itself CREATES — `sensor_rollup`, `command_rollup_daily`, `device_availability_daily` —
// was invisible in the one figure retention is judged by. A panel that says "history tables" while
// omitting the tables the feature writes understates the total AND hides the trade a tier list
// exists to make: raw shrinks, rollups grow. On the dev stack that was 3,138 unreported rows under
// a headline claiming to be the whole of it.

const estimate = (rows: number, perRow: number): UsageBucket => ({
  rows,
  bytes: rows * perRow,
  estimated: true,
});

/**
 * The bucket the two DATE-keyed rollup tables store under.
 *
 * `command_rollup_daily` and `device_availability_daily` are keyed by a DATE, so whatever a tier
 * list says, one row is one day and the whole count belongs to `1d`. A list carrying a coarser
 * whole-day tier (`1w`) will correctly show nothing stored under it — nothing builds one.
 */
const DAILY_BUCKET = '1d';

export const retentionUsageService = {
  /**
   * Rows and bytes per data kind, and per bucket within each kind. `null` is the platform total.
   *
   * One path for both the admin and the user view, keyed only by `userId`, so the two can never
   * drift into counting different things.
   *
   * Only frames are measured — `camera_frame_history.byte_size` is recorded at write time. The rest
   * are per-row estimates from `@lattice/retention`'s constants (shared with the worker's "bytes
   * reclaimed", so the two numbers are in the same units), LABELLED as estimates in the UI rather
   * than presented as measurements: measuring them would mean `pg_total_relation_size` per user,
   * which is not a thing Postgres can do.
   */
  async usage(userId: number | null): Promise<Record<string, KindUsage>> {
    const actionScope =
      userId === null ? {} : { user_device_action: { user_device: { user_id: userId } } };
    const deviceScope = userId === null ? {} : { user_device: { user_id: userId } };
    const userScope = userId === null ? {} : { user_id: userId };

    const [frames, frameBytes, readings, commands, events, rollups, commandDaily, availability] =
      await Promise.all([
        db.cameraFrameHistory.count({ where: actionScope }),
        db.cameraFrameHistory.aggregate({ where: actionScope, _sum: { byte_size: true } }),
        db.sensorHistory.count({ where: actionScope }),
        db.deviceCommand.count({ where: userScope }),
        db.deviceEvent.count({ where: userScope }),
        // The one query the new index exists for: platform-wide this groups across every action,
        // where `bucket` is not a prefix of the composite index and would otherwise seq-scan.
        db.sensorRollup.groupBy({ by: ['bucket'], where: actionScope, _count: { _all: true } }),
        db.commandRollupDaily.count({ where: actionScope }),
        db.deviceAvailabilityDaily.count({ where: deviceScope }),
      ]);

    const readingBuckets: Record<string, UsageBucket> = {
      [RAW_BUCKET]: estimate(readings, READING_BYTES),
    };
    for (const r of rollups) readingBuckets[r.bucket] = estimate(r._count._all, ROLLUP_BYTES);

    return {
      readings: sumUsage(readingBuckets),
      // The only measured figure in the feature, and the only kind that can never have a rollup:
      // a frame is an image, and there is no average of two images.
      frames: sumUsage({
        [RAW_BUCKET]: {
          rows: frames,
          bytes: frameBytes._sum.byte_size ?? 0,
          estimated: false,
        },
      }),
      commands: sumUsage({
        [RAW_BUCKET]: estimate(commands, COMMAND_BYTES),
        [DAILY_BUCKET]: estimate(commandDaily, COMMAND_ROLLUP_BYTES),
      }),
      events: sumUsage({
        [RAW_BUCKET]: estimate(events, EVENT_BYTES),
        [DAILY_BUCKET]: estimate(availability, AVAILABILITY_BYTES),
      }),
    };
  },
};
