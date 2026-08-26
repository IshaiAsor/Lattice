import { db } from '../db';

// How much history is actually stored — for one user, or platform-wide.
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

export const retentionUsageService = {
  /**
   * Rows and bytes per data kind. `null` is the platform total.
   *
   * Only frames are measured — `camera_frame_history.byte_size` is recorded at write time. The rest
   * are per-row estimates, LABELLED as estimates in the UI rather than presented as measurements,
   * because measuring them would mean `pg_total_relation_size` per user, which is not a thing
   * Postgres can do.
   */
  async usage(userId: number | null) {
    const actionScope =
      userId === null ? {} : { user_device_action: { user_device: { user_id: userId } } };

    const [frames, frameBytes, readings, commands, events] = await Promise.all([
      db.cameraFrameHistory.count({ where: actionScope }),
      db.cameraFrameHistory.aggregate({ where: actionScope, _sum: { byte_size: true } }),
      db.sensorHistory.count({ where: actionScope }),
      db.deviceCommand.count({ where: userId === null ? {} : { user_id: userId } }),
      db.deviceEvent.count({ where: userId === null ? {} : { user_id: userId } }),
    ]);

    const READING_BYTES = 48;
    const COMMAND_BYTES = 180;
    const EVENT_BYTES = 120;

    return {
      frames: { rows: frames, bytes: frameBytes._sum.byte_size ?? 0 },
      readings: { rows: readings, bytes: readings * READING_BYTES },
      commands: { rows: commands, bytes: commands * COMMAND_BYTES },
      events: { rows: events, bytes: events * EVENT_BYTES },
    };
  },
};
