-- F18 — history rollups, device lifecycle events, frame split and the retention policy.
--
-- sensor_history and device_commands are the RAW tiers and already exist. This adds the derived
-- tiers that stay cheap forever, the lifecycle trail that never existed at all, and the policy row
-- that decides how long each raw tier lives.
--
-- Nothing here deletes anything. The frame split MOVES rows between tables inside one transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- Downsampled scalar readings.
-- sample_count counts every reading; numeric_count only those that parsed as a number, because
-- sensor_history.value is TEXT and a switch's history is "on"/"off". For non-numeric series
-- min/max/avg stay NULL and last_value is the only meaningful summary.
CREATE TABLE "sensor_rollup" (
  "id"                    SERIAL PRIMARY KEY,
  "user_device_action_id" INTEGER NOT NULL,
  "bucket"                VARCHAR(8) NOT NULL,
  "bucket_start"          TIMESTAMPTZ(6) NOT NULL,
  "sample_count"          INTEGER NOT NULL DEFAULT 0,
  "numeric_count"         INTEGER NOT NULL DEFAULT 0,
  "error_count"           INTEGER NOT NULL DEFAULT 0,
  "min_value"             DOUBLE PRECISION,
  "max_value"             DOUBLE PRECISION,
  "avg_value"             DOUBLE PRECISION,
  "last_value"            VARCHAR(255),
  CONSTRAINT "sensor_rollup_user_device_action_id_fkey"
    FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The unique key is what makes the nightly upsert idempotent, so a re-run or a missed night
-- self-heals instead of double-counting.
CREATE UNIQUE INDEX "sensor_rollup_user_device_action_id_bucket_bucket_start_key"
  ON "sensor_rollup" ("user_device_action_id", "bucket", "bucket_start");
CREATE INDEX "sensor_rollup_user_device_action_id_bucket_bucket_start_idx"
  ON "sensor_rollup" ("user_device_action_id", "bucket", "bucket_start");

-- ─────────────────────────────────────────────────────────────────────────────
-- Everything that happened *to* a device. Written on a REAL transition only.
CREATE TABLE "device_events" (
  "id"             SERIAL PRIMARY KEY,
  "user_id"        INTEGER NOT NULL,
  "user_device_id" INTEGER NOT NULL,
  "kind"           VARCHAR(16) NOT NULL,
  "from_value"     VARCHAR(255),
  "to_value"       VARCHAR(255),
  "detail"         JSONB,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_events_user_device_id_fkey"
    FOREIGN KEY ("user_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- "what happened to this device" and "what happened across my home".
CREATE INDEX "device_events_user_device_id_recorded_at_idx"
  ON "device_events" ("user_device_id", "recorded_at");
CREATE INDEX "device_events_user_id_recorded_at_idx"
  ON "device_events" ("user_id", "recorded_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- Daily uptime, folded from consecutive device_events plus the day boundary.
CREATE TABLE "device_availability_daily" (
  "id"              SERIAL PRIMARY KEY,
  "user_device_id"  INTEGER NOT NULL,
  "day"             DATE NOT NULL,
  "online_seconds"  INTEGER NOT NULL DEFAULT 0,
  "offline_seconds" INTEGER NOT NULL DEFAULT 0,
  "transitions"     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "device_availability_daily_user_device_id_fkey"
    FOREIGN KEY ("user_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "device_availability_daily_user_device_id_day_key"
  ON "device_availability_daily" ("user_device_id", "day");
CREATE INDEX "device_availability_daily_user_device_id_day_idx"
  ON "device_availability_daily" ("user_device_id", "day");

-- ─────────────────────────────────────────────────────────────────────────────
-- Camera frames, split out of sensor_history.
-- A read-performance change, not a retention one: full frame history is kept on purpose. Every
-- scalar series query was walking a table whose image rows are ~40 KB of base64 each.
CREATE TABLE "camera_frame_history" (
  "id"                    SERIAL PRIMARY KEY,
  "user_device_action_id" INTEGER NOT NULL,
  "value"                 TEXT NOT NULL,
  "byte_size"             INTEGER NOT NULL DEFAULT 0,
  "recorded_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "camera_frame_history_user_device_action_id_fkey"
    FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "camera_frame_history_user_device_action_id_recorded_at_idx"
  ON "camera_frame_history" ("user_device_action_id", "recorded_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- Daily command counts per (action, source, outcome).
CREATE TABLE "command_rollup_daily" (
  "id"                    SERIAL PRIMARY KEY,
  "user_device_action_id" INTEGER NOT NULL,
  "day"                   DATE NOT NULL,
  "source"                VARCHAR(20) NOT NULL,
  "status"                VARCHAR(20) NOT NULL,
  "count"                 INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "command_rollup_daily_user_device_action_id_fkey"
    FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "command_rollup_daily_user_device_action_id_day_source_status_key"
  ON "command_rollup_daily" ("user_device_action_id", "day", "source", "status");
CREATE INDEX "command_rollup_daily_user_device_action_id_day_idx"
  ON "command_rollup_daily" ("user_device_action_id", "day");

-- ─────────────────────────────────────────────────────────────────────────────
-- Retention comes in two layers.
--
--   retention_policy           — the platform default a user gets before choosing anything,
--                                plus the ceiling they may not exceed. Admin-owned.
--   user_retention_preferences — one user's override. A row exists only once they have actually
--                                chosen something, so a new account needs no seeding and the
--                                absence of a row means "use the default".
--
-- Two tables rather than one with a nullable user_id, because Postgres treats NULLs as DISTINCT
-- in a unique index: UNIQUE(user_id, data_kind) would happily allow two platform rows for the
-- same kind. A partial unique index would work but cannot be expressed in schema.prisma, so the
-- schema would no longer describe the database.
--
-- On the *_days columns 0 means KEEP FOREVER, not "delete immediately" — the safe reading for a
-- column driving deletes. On the max_* ceilings NULL means UNCAPPED, which is deliberately a
-- different spelling: a ceiling of 0 would otherwise read as "cap everyone at forever".
CREATE TABLE "retention_policy" (
  "id"                  SERIAL PRIMARY KEY,
  "data_kind"           VARCHAR(20) NOT NULL,
  "default_raw_days"    INTEGER NOT NULL DEFAULT 0,
  "default_hourly_days" INTEGER,
  "default_daily_days"  INTEGER,
  "max_raw_days"        INTEGER,
  "max_hourly_days"     INTEGER,
  "max_daily_days"      INTEGER,
  "enabled"             BOOLEAN NOT NULL DEFAULT TRUE,
  "updated_by_user_id"  INTEGER,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_policy_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "retention_policy_data_kind_key" ON "retention_policy" ("data_kind");

CREATE TABLE "user_retention_preferences" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER NOT NULL,
  "data_kind"   VARCHAR(20) NOT NULL,
  "raw_days"    INTEGER NOT NULL DEFAULT 0,
  "hourly_days" INTEGER,
  "daily_days"  INTEGER,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_retention_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_retention_preferences_user_id_data_kind_key"
  ON "user_retention_preferences" ("user_id", "data_kind");

-- Seed the four platform defaults. ON CONFLICT so a re-run is harmless.
--   scalar        raw 14d  → hourly 90d → daily forever
--   command       raw 365d →            → daily forever
--   device_event  kept forever (low volume, and the availability rollup is derived from it)
--   frame         kept forever ON PURPOSE — full image history is a product decision.
--
-- Every ceiling ships NULL, so nothing is capped on day one and behaviour matches the decision
-- above. The columns exist so a volume with no headroom can be defended later from the admin
-- page rather than from a migration.
INSERT INTO "retention_policy"
  ("data_kind", "default_raw_days", "default_hourly_days", "default_daily_days", "enabled")
VALUES
  ('scalar',       14,   90,    0, TRUE),
  ('command',     365, NULL,    0, TRUE),
  ('device_event',  0, NULL,    0, TRUE),
  ('frame',         0, NULL, NULL, TRUE)
ON CONFLICT ("data_kind") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: move existing image rows out of sensor_history into camera_frame_history.
--
-- Selected by the same discriminator digest-service uses at runtime
-- (services/digest-service/src/resolve.ts): DeviceCapability.implementation_type = 'CameraAction'.
-- Not by value length — a long scalar is legal, and guessing would silently move the wrong rows.
--
-- byte_size is the decoded size, which is what the storage panel wants to total: base64 carries
-- 4 characters per 3 bytes, minus any '=' padding.
INSERT INTO "camera_frame_history" ("user_device_action_id", "value", "byte_size", "recorded_at")
SELECT
  sh."user_device_action_id",
  sh."value",
  FLOOR(LENGTH(sh."value") * 3 / 4) - (CASE WHEN RIGHT(sh."value", 2) = '==' THEN 2
                                            WHEN RIGHT(sh."value", 1) = '='  THEN 1
                                            ELSE 0 END),
  sh."recorded_at"
FROM "sensor_history" sh
JOIN "user_device_actions" uda ON uda."id" = sh."user_device_action_id"
JOIN "device_capabilities" dc  ON dc."id" = uda."capability_id"
WHERE dc."implementation_type" = 'CameraAction'
  AND sh."value" IS NOT NULL;

-- Fault rows for a camera action carry value NULL and belong to neither table's happy path; they
-- stay in sensor_history, where is_error rows already live and where the error timeline reads them.
DELETE FROM "sensor_history" sh
USING "user_device_actions" uda, "device_capabilities" dc
WHERE uda."id" = sh."user_device_action_id"
  AND dc."id" = uda."capability_id"
  AND dc."implementation_type" = 'CameraAction'
  AND sh."value" IS NOT NULL;
