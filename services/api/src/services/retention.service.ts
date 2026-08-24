import { db } from '../db';
import { assertDefaultWithinCeiling } from './retention-rules';

// Retention config (F18 / Step 2). Two layers, deliberately:
//
//   retention_policy            the default a user starts on + the ceiling they may not exceed.
//   user_retention_preferences  one user's override. A row exists only once they change something,
//                               so changing a default moves everyone who never customised.
//
// The effective-window arithmetic lives in the worker (retention-logic.ts) because that is what
// enforces it. This service exposes the two layers for editing and mirrors the clamp for display,
// so the UI can show what will actually happen rather than what was typed.

const KINDS = ['scalar', 'frame', 'command', 'device_event'] as const;
export type DataKind = (typeof KINDS)[number];

function assertKind(kind: string): asserts kind is DataKind {
  if (!(KINDS as readonly string[]).includes(kind))
    throw Object.assign(new Error(`Unknown data kind: ${kind}`), { statusCode: 400 });
}

/**
 * Validate a days value from a client.
 *
 * 0 is legal and means forever; negative is not. Undefined means "leave this tier alone", which is
 * different from null ("this tier does not apply"), so both survive round-tripping.
 */
function days(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw Object.assign(new Error(`${field} must be a whole number of days, or 0 for forever`), {
      statusCode: 400,
    });
  // A decade is not a limit anyone means; it is a typo that would look like it worked.
  if (n > 3650)
    throw Object.assign(new Error(`${field} may not exceed 3650 days — use 0 for forever`), {
      statusCode: 400,
    });
  return n;
}

/** Mirror of the worker's clamp, for display only. See retention-logic.clampDays. */
function effective(chosen: number | null, ceiling: number | null): number | null {
  if (chosen === null) return null;
  if (ceiling === null) return chosen;
  if (chosen === 0) return ceiling;
  return Math.min(chosen, ceiling);
}

export const retentionService = {
  /** The platform layer, admin-facing. */
  async listPolicies() {
    const rows = await db.retentionPolicy.findMany({ orderBy: { id: 'asc' } });
    return rows.map((r) => ({
      dataKind: r.data_kind,
      defaultRawDays: r.default_raw_days,
      defaultHourlyDays: r.default_hourly_days,
      defaultDailyDays: r.default_daily_days,
      maxRawDays: r.max_raw_days,
      maxHourlyDays: r.max_hourly_days,
      maxDailyDays: r.max_daily_days,
      enabled: r.enabled,
      updatedAt: r.updated_at.toISOString(),
    }));
  },

  async updatePolicy(adminId: number, kind: string, body: Record<string, unknown>) {
    assertKind(kind);
    // default_raw_days is NOT NULL, so it is spread in only when a real number arrived: undefined
    // means "leave it alone", and null has no meaning on a column that cannot hold one.
    const rawDefault = days(body['defaultRawDays'], 'defaultRawDays');
    const rawCeiling = days(body['maxRawDays'], 'maxRawDays');

    // Both halves are optional in a PUT, so the pair has to be checked as it will END UP, not as
    // it arrived: lowering only the ceiling is exactly how the invalid combination gets made.
    const current = await db.retentionPolicy.findUniqueOrThrow({ where: { data_kind: kind } });
    assertDefaultWithinCeiling(
      typeof rawDefault === 'number' ? rawDefault : current.default_raw_days,
      rawCeiling !== undefined ? rawCeiling : current.max_raw_days,
    );

    await db.retentionPolicy.update({
      where: { data_kind: kind },
      data: {
        ...(typeof rawDefault === 'number' ? { default_raw_days: rawDefault } : {}),
        default_hourly_days: days(body['defaultHourlyDays'], 'defaultHourlyDays'),
        default_daily_days: days(body['defaultDailyDays'], 'defaultDailyDays'),
        max_raw_days: rawCeiling,
        max_hourly_days: days(body['maxHourlyDays'], 'maxHourlyDays'),
        max_daily_days: days(body['maxDailyDays'], 'maxDailyDays'),
        ...(typeof body['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
        updated_by_user_id: adminId,
      },
    });
    return this.listPolicies();
  },

  /**
   * What THIS user's retention actually is, per kind — their choice where they made one, the
   * platform default where they did not, and what the ceiling turns that into.
   */
  async mine(userId: number) {
    const [policies, prefs] = await Promise.all([
      db.retentionPolicy.findMany(),
      db.userRetentionPreference.findMany({ where: { user_id: userId } }),
    ]);
    const byKind = new Map(prefs.map((p) => [p.data_kind, p]));
    return policies.map((p) => {
      const mine = byKind.get(p.data_kind);
      const raw = mine?.raw_days ?? p.default_raw_days;
      return {
        dataKind: p.data_kind,
        // `overridden` is what drives the Default/Custom chip: the presence of a row, not a value
        // comparison. A user who deliberately set 14 while the default is also 14 has still made a
        // choice, and must not be silently moved when the default changes.
        overridden: mine !== undefined,
        rawDays: raw,
        hourlyDays: mine?.hourly_days ?? p.default_hourly_days,
        dailyDays: mine?.daily_days ?? p.default_daily_days,
        defaultRawDays: p.default_raw_days,
        maxRawDays: p.max_raw_days,
        effectiveRawDays: effective(raw, p.max_raw_days),
        enabled: p.enabled,
      };
    });
  },

  async setMine(userId: number, kind: string, body: Record<string, unknown>) {
    assertKind(kind);
    const raw = days(body['rawDays'], 'rawDays');
    const hourly = days(body['hourlyDays'], 'hourlyDays');
    const daily = days(body['dailyDays'], 'dailyDays');
    await db.userRetentionPreference.upsert({
      where: { user_id_data_kind: { user_id: userId, data_kind: kind } },
      create: {
        user_id: userId,
        data_kind: kind,
        raw_days: raw ?? 0,
        hourly_days: hourly ?? null,
        daily_days: daily ?? null,
      },
      update: {
        ...(raw !== undefined && raw !== null ? { raw_days: raw } : {}),
        ...(hourly !== undefined ? { hourly_days: hourly } : {}),
        ...(daily !== undefined ? { daily_days: daily } : {}),
      },
    });
    return this.mine(userId);
  },

  /**
   * Reset a kind to the platform default by DELETING the override row.
   *
   * Not by writing today's default into it: that would freeze the user at the current value and
   * quietly break the property that makes defaults worth having — that changing one moves everyone
   * who never customised.
   */
  async resetMine(userId: number, kind: string) {
    assertKind(kind);
    await db.userRetentionPreference.deleteMany({
      where: { user_id: userId, data_kind: kind },
    });
    return this.mine(userId);
  },

  /**
   * Storage figures. Scoped to one user, or platform-wide for an admin.
   *
   * Frame bytes are summed from the stored `byte_size` rather than measured from the TEXT column —
   * measuring would mean reading every frame off disk to answer a page load.
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

    // Rough per-row costs for the tables we do not measure directly. Labelled as estimates in the
    // UI rather than presented as measurements — an exact figure would need pg_total_relation_size
    // per user, which is not a thing Postgres can do.
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

  /** Which users have overridden something — the admin table. */
  async overrides() {
    const rows = await db.userRetentionPreference.findMany({
      include: { user: { select: { id: true, full_name: true, email: true } } },
      orderBy: { user_id: 'asc' },
    });
    return rows.map((r) => ({
      userId: r.user_id,
      userName: r.user.full_name ?? r.user.email,
      dataKind: r.data_kind,
      rawDays: r.raw_days,
      hourlyDays: r.hourly_days,
      dailyDays: r.daily_days,
      updatedAt: r.updated_at.toISOString(),
    }));
  },
};
