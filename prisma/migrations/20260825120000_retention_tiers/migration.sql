-- F18 Phase 2 — elastic, scoped retention tiers.
--
-- Phase 1 froze the retention shape in code: `sensor_rollup.bucket` was only ever 'hour' or 'day',
-- and every window lived in six columns on `retention_policy` plus three on
-- `user_retention_preferences`. This makes the tier list DATA — any number of tiers, any admissible
-- size, configurable at five scopes — and makes `raw` position 0 of that list rather than a
-- separate kind-level window.
--
-- ORDER IS LOAD-BEARING. Steps 1–5 must all run before step 6, which is the one that checks them.
--
-- EXPAND ONLY. The six `retention_policy` day columns and `user_retention_preferences` are NOT
-- dropped here even though nothing new reads them: the API and worker still do, and they move off
-- one at a time in later steps. Their data has been COPIED, not moved, so this migration is fully
-- reversible by dropping the new tables. The contract half is its own migration.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The bucket vocabulary. FIRST, because everything below references it.
--
-- A real catalog, editable by any user — not a constant list in code. Flooring is generic
-- (`floor((epoch - anchor) / seconds) * seconds + anchor`), so a size nobody has seen before floors
-- correctly the first time it is used.
CREATE TABLE "retention_buckets" (
  "code"                  VARCHAR(12) PRIMARY KEY,
  -- 0 is the `raw` sentinel: raw is a tier in every way that matters, but it is not a duration —
  -- rows are written one per reading, not folded onto a grid.
  "seconds"               INTEGER NOT NULL,
  "label"                 VARCHAR(32) NOT NULL,
  -- Shifts the boundary grid. 0 for everything except '1w': flooring on multiples of 604800 lands
  -- on a THURSDAY, since 1 Jan 1970 was one, so it carries four days to move the grid to Monday.
  "anchor_offset_seconds" INTEGER NOT NULL DEFAULT 0,
  "is_builtin"            BOOLEAN NOT NULL DEFAULT false,
  "created_by_user_id"    INTEGER,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_buckets_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "retention_buckets_seconds_idx" ON "retention_buckets"("seconds");

INSERT INTO "retention_buckets" ("code", "seconds", "label", "anchor_offset_seconds", "is_builtin") VALUES
  ('raw',      0,      'Raw readings', 0,      true),
  ('5m',       300,    '5 minutes',    0,      true),
  ('15m',      900,    '15 minutes',   0,      true),
  ('30m',      1800,   '30 minutes',   0,      true),
  ('1h',       3600,   '1 hour',       0,      true),
  ('6h',       21600,  '6 hours',      0,      true),
  ('12h',      43200,  '12 hours',     0,      true),
  ('1d',       86400,  '1 day',        0,      true),
  ('1w',       604800, '1 week',       345600, true)
ON CONFLICT ("code") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The five tier tables, one per scope.
--
-- Not one table with a nullable owner: Postgres treats NULLs as DISTINCT in a unique index, so a
-- nullable-owner key would admit two platform rows for the same (data_kind, bucket). A partial
-- unique index would fix that but cannot be expressed in schema.prisma, so the schema would stop
-- describing the database.
--
-- Every `bucket` is FK'd ON DELETE RESTRICT: removing a size must never cascade into deleting the
-- history configured under it.

CREATE TABLE "retention_policy_tiers" (
  "id"                 SERIAL PRIMARY KEY,
  "data_kind"          VARCHAR(20) NOT NULL,
  "bucket"             VARCHAR(12) NOT NULL,
  -- 0 = KEEP FOREVER — the safe reading for a number that drives DELETEs.
  "keep_days"          INTEGER NOT NULL DEFAULT 0,
  -- NULL = uncapped. Deliberately not 0, which would read as "cap everyone at forever".
  "max_keep_days"      INTEGER,
  "position"           INTEGER NOT NULL DEFAULT 0,
  "updated_by_user_id" INTEGER,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_policy_tiers_data_kind_fkey"
    FOREIGN KEY ("data_kind") REFERENCES "retention_policy"("data_kind") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "retention_policy_tiers_bucket_fkey"
    FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "retention_policy_tiers_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "retention_policy_tiers_data_kind_bucket_key" ON "retention_policy_tiers"("data_kind", "bucket");
CREATE INDEX "retention_policy_tiers_data_kind_position_idx" ON "retention_policy_tiers"("data_kind", "position");

CREATE TABLE "user_retention_tiers" (
  "id"         SERIAL PRIMARY KEY,
  "user_id"    INTEGER NOT NULL,
  "data_kind"  VARCHAR(20) NOT NULL,
  "bucket"     VARCHAR(12) NOT NULL,
  "keep_days"  INTEGER NOT NULL DEFAULT 0,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_retention_tiers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_retention_tiers_bucket_fkey"
    FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_retention_tiers_user_id_data_kind_bucket_key" ON "user_retention_tiers"("user_id", "data_kind", "bucket");
CREATE INDEX "user_retention_tiers_user_id_data_kind_position_idx" ON "user_retention_tiers"("user_id", "data_kind", "position");

CREATE TABLE "device_retention_tiers" (
  "id"             SERIAL PRIMARY KEY,
  "user_device_id" INTEGER NOT NULL,
  "data_kind"      VARCHAR(20) NOT NULL,
  "bucket"         VARCHAR(12) NOT NULL,
  "keep_days"      INTEGER NOT NULL DEFAULT 0,
  "position"       INTEGER NOT NULL DEFAULT 0,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_retention_tiers_user_device_id_fkey"
    FOREIGN KEY ("user_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_retention_tiers_bucket_fkey"
    FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "device_retention_tiers_user_device_id_data_kind_bucket_key" ON "device_retention_tiers"("user_device_id", "data_kind", "bucket");
CREATE INDEX "device_retention_tiers_user_device_id_data_kind_position_idx" ON "device_retention_tiers"("user_device_id", "data_kind", "position");

CREATE TABLE "action_retention_tiers" (
  "id"                    SERIAL PRIMARY KEY,
  "user_device_action_id" INTEGER NOT NULL,
  "data_kind"             VARCHAR(20) NOT NULL,
  "bucket"                VARCHAR(12) NOT NULL,
  "keep_days"             INTEGER NOT NULL DEFAULT 0,
  "position"              INTEGER NOT NULL DEFAULT 0,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "action_retention_tiers_user_device_action_id_fkey"
    FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "action_retention_tiers_bucket_fkey"
    FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "action_retention_tiers_user_device_action_id_data_kind_buck_key" ON "action_retention_tiers"("user_device_action_id", "data_kind", "bucket");
CREATE INDEX "action_retention_tiers_user_device_action_id_data_kind_posi_idx" ON "action_retention_tiers"("user_device_action_id", "data_kind", "position");

-- slot_key and action_name are plain strings for the same reason blueprint_slot_bindings.slot_key
-- is one: they survive a v2 publish recreating the slot rows.
CREATE TABLE "blueprint_retention_tiers" (
  "id"           SERIAL PRIMARY KEY,
  "blueprint_id" INTEGER NOT NULL,
  "slot_key"     VARCHAR(64) NOT NULL,
  "action_name"  VARCHAR(64) NOT NULL,
  "data_kind"    VARCHAR(20) NOT NULL,
  "bucket"       VARCHAR(12) NOT NULL,
  "keep_days"    INTEGER NOT NULL DEFAULT 0,
  "position"     INTEGER NOT NULL DEFAULT 0,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blueprint_retention_tiers_blueprint_id_fkey"
    FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "blueprint_retention_tiers_bucket_fkey"
    FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "blueprint_retention_tiers_blueprint_id_slot_key_action_name_key"
  ON "blueprint_retention_tiers"("blueprint_id", "slot_key", "action_name", "data_kind", "bucket");
CREATE INDEX "blueprint_retention_tiers_blueprint_id_slot_key_action_name_idx"
  ON "blueprint_retention_tiers"("blueprint_id", "slot_key", "action_name");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Job history (F18.14).
CREATE TABLE "retention_runs" (
  "id"                   SERIAL PRIMARY KEY,
  "trigger"              VARCHAR(8) NOT NULL,
  "status"               VARCHAR(10) NOT NULL,
  "phase"                VARCHAR(32),
  "requested_by_user_id" INTEGER,
  "scope_user_id"        INTEGER,
  -- 'global' or 'user:<id>', held from queued until terminal then set NULL. Postgres's
  -- NULL-distinct rule is documented as a trap everywhere else in this schema; here it is the
  -- feature — any number of finished rows carry NULL, and exactly one live run holds each key.
  "lock_key"             VARCHAR(32),
  "queued_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"           TIMESTAMPTZ(6),
  "finished_at"          TIMESTAMPTZ(6),
  "duration_ms"          INTEGER,
  "error"                TEXT,
  CONSTRAINT "retention_runs_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "retention_runs_lock_key_key" ON "retention_runs"("lock_key");
CREATE INDEX "retention_runs_queued_at_idx" ON "retention_runs"("queued_at");
CREATE INDEX "retention_runs_scope_user_id_queued_at_idx" ON "retention_runs"("scope_user_id", "queued_at");

CREATE TABLE "retention_run_kinds" (
  "id"              SERIAL PRIMARY KEY,
  "run_id"          INTEGER NOT NULL,
  "data_kind"       VARCHAR(20) NOT NULL,
  "buckets_written" INTEGER NOT NULL DEFAULT 0,
  "rows_deleted"    INTEGER NOT NULL DEFAULT 0,
  "bytes_reclaimed" BIGINT NOT NULL DEFAULT 0,
  -- False only for frames, where byte_size is summed off the rows before deleting them.
  "bytes_estimated" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "retention_run_kinds_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "retention_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "retention_run_kinds_run_id_data_kind_key" ON "retention_run_kinds"("run_id", "data_kind");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Fold the platform columns into tier rows.
--
-- `raw` at position 0 for EVERY kind — it is mandatory, and a kind without it would have no
-- statement at all about how long the readings themselves are kept.
INSERT INTO "retention_policy_tiers" ("data_kind", "bucket", "keep_days", "max_keep_days", "position")
SELECT "data_kind", 'raw', "default_raw_days", "max_raw_days", 0
FROM "retention_policy"
ON CONFLICT ("data_kind", "bucket") DO NOTHING;

-- A NULL default with a non-NULL ceiling STILL becomes a row, or the ceiling is silently lost.
INSERT INTO "retention_policy_tiers" ("data_kind", "bucket", "keep_days", "max_keep_days", "position")
SELECT "data_kind", '1h', COALESCE("default_hourly_days", 0), "max_hourly_days", 1
FROM "retention_policy"
WHERE "default_hourly_days" IS NOT NULL OR "max_hourly_days" IS NOT NULL
ON CONFLICT ("data_kind", "bucket") DO NOTHING;

INSERT INTO "retention_policy_tiers" ("data_kind", "bucket", "keep_days", "max_keep_days", "position")
SELECT "data_kind", '1d', COALESCE("default_daily_days", 0), "max_daily_days", 2
FROM "retention_policy"
WHERE "default_daily_days" IS NOT NULL OR "max_daily_days" IS NOT NULL
ON CONFLICT ("data_kind", "bucket") DO NOTHING;

-- 5. Fold every user override the same way. Again raw always, rollup tiers only where set.
INSERT INTO "user_retention_tiers" ("user_id", "data_kind", "bucket", "keep_days", "position")
SELECT "user_id", "data_kind", 'raw', "raw_days", 0
FROM "user_retention_preferences"
ON CONFLICT ("user_id", "data_kind", "bucket") DO NOTHING;

INSERT INTO "user_retention_tiers" ("user_id", "data_kind", "bucket", "keep_days", "position")
SELECT "user_id", "data_kind", '1h', "hourly_days", 1
FROM "user_retention_preferences"
WHERE "hourly_days" IS NOT NULL
ON CONFLICT ("user_id", "data_kind", "bucket") DO NOTHING;

INSERT INTO "user_retention_tiers" ("user_id", "data_kind", "bucket", "keep_days", "position")
SELECT "user_id", "data_kind", '1d', "daily_days", 2
FROM "user_retention_preferences"
WHERE "daily_days" IS NOT NULL
ON CONFLICT ("user_id", "data_kind", "bucket") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Rewrite the existing rollup vocabulary.
--
-- Phase 1 wrote these literals from code. Without this UPDATE every bucket ever written becomes
-- invisible to the new reader and is deleted by the orphan sweep on the first pass. No collision is
-- possible: nothing has ever written '1h'/'1d'.
UPDATE "sensor_rollup" SET "bucket" = '1h' WHERE "bucket" = 'hour';
UPDATE "sensor_rollup" SET "bucket" = '1d' WHERE "bucket" = 'day';

ALTER TABLE "sensor_rollup" ALTER COLUMN "bucket" TYPE VARCHAR(12);

-- 7. THE CHECK. Postgres validates every existing row as it adds this constraint, so a missed or
-- partial step 6 fails the migration LOUDLY instead of silently orphaning every rollup ever
-- written. What was the most dangerous line in this file becomes a checked one.
ALTER TABLE "sensor_rollup"
  ADD CONSTRAINT "sensor_rollup_bucket_fkey"
  FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. The two new knobs on retention_policy.
--
-- min_bucket is the finest SUMMARY anyone may configure. It ships as 'raw' — i.e. no floor — so
-- this migration changes nobody's options; it exists so a volume with no headroom can be defended
-- later without a schema change, exactly as max_raw_days already does.
ALTER TABLE "retention_policy"
  ADD COLUMN IF NOT EXISTS "min_bucket" VARCHAR(12) NOT NULL DEFAULT 'raw',
  ADD COLUMN IF NOT EXISTS "max_tiers"  INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "retention_policy"
  ADD CONSTRAINT "retention_policy_min_bucket_fkey"
  FOREIGN KEY ("min_bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Per-kind tier ceilings. The numbers are storage facts, not policy: command_rollup_daily and
-- device_availability_daily are DATE-keyed, so those kinds can only ever hold raw + whole days; and
-- a camera frame is an image, which does not average, so frame is raw and nothing else.
UPDATE "retention_policy" SET "max_tiers" = 5 WHERE "data_kind" = 'scalar';
UPDATE "retention_policy" SET "max_tiers" = 2 WHERE "data_kind" IN ('command', 'device_event');
UPDATE "retention_policy" SET "max_tiers" = 1 WHERE "data_kind" = 'frame';
