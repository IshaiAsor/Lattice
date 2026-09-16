-- F18.18 — the sweep schedule becomes data, and turns out to be four schedules.
--
-- Everything else Phase 2 touched became data: windows, tier counts, bucket sizes, ceilings, the
-- per-kind `enabled` flag. The schedule stayed `RETENTION_CRON`, read once at worker startup and
-- overridden nowhere, so changing it in prod meant a GitOps commit plus a Kargo promotion.
--
-- FOUR rows rather than one. F18.17 split the pass in two on the observation that building a bucket
-- and deleting a row never shared a cost; the destructive half was still three jobs sharing one
-- schedule, and the orphan sweep in particular fires on a CONFIGURATION change rather than on a
-- window expiring — dropping a tier should not have to wait for the hour chosen for deleting a
-- million raw readings.
--
-- EXPAND ONLY, and seeded so that day-one behaviour is identical to the day before:
--   bucket_build   cron NULL  — derive from the finest configured tier, exactly F18.17
--   the other three  '0 0 3 * * *' / UTC — the single cron they have all been riding on

-- 1. The schedules.
CREATE TABLE "retention_schedule" (
  "id"                 SERIAL       PRIMARY KEY,
  -- bucket_build | data_sweep | bucket_delete | orphan_sweep
  "job"                VARCHAR(16)  NOT NULL,
  -- NULL = derive from the finest configured tier. Meaningful on bucket_build alone; the API
  -- refuses it on the other three, which have nothing to derive from. This is the THIRD encoding
  -- in a feature that already has two (0 = forever on a window, NULL = uncapped on a ceiling), so
  -- it is spelled out everywhere it is read rather than inferred.
  "cron"               VARCHAR(120),
  -- A quiet hour is a local wall-clock concept. 'UTC' because that is what the worker container has
  -- always been (no TZ in compose or in the k8s manifests), so nothing shifts on deploy.
  "timezone"           VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  "enabled"            BOOLEAN      NOT NULL DEFAULT true,
  "updated_by_user_id" INTEGER,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "retention_schedule_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "retention_schedule_job_key" ON "retention_schedule"("job");

-- 2. Seed the four. ON CONFLICT so a re-run is harmless, matching the Phase 1 seed's style.
INSERT INTO "retention_schedule" ("job", "cron", "timezone", "enabled")
VALUES
  ('bucket_build',  NULL,          'UTC', true),
  ('data_sweep',    '0 0 3 * * *', 'UTC', true),
  ('bucket_delete', '0 0 3 * * *', 'UTC', true),
  ('orphan_sweep',  '0 0 3 * * *', 'UTC', true)
ON CONFLICT ("job") DO NOTHING;

-- 3. WHAT a run did, beside WHY it exists.
--
-- `trigger` has been carrying two axes: `rollup` says both "the interval fired" and "it only built
-- buckets", while `cron` says only the first. Splitting them lets the four jobs each have their own
-- schedule and their own "when did this last finish", which is the whole mechanism.
ALTER TABLE "retention_runs"
  ADD COLUMN IF NOT EXISTS "job" VARCHAR(12) NOT NULL DEFAULT 'full';

-- Backfill: every historical interval pass built buckets and deleted nothing. Everything else —
-- cron, catchup, admin, user — ran the whole thing, which is what 'full' means.
UPDATE "retention_runs" SET "job" = 'build' WHERE "trigger" = 'rollup';

-- The tick asks "when did THIS job last finish?" on every heartbeat, so it wants the same shape as
-- the existing (scope_user_id, queued_at) index rather than a scan per job.
CREATE INDEX IF NOT EXISTS "retention_runs_job_finished_at_idx"
  ON "retention_runs"("job", "finished_at");
