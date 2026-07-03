-- Unify pipeline "sensors" and enrich-stage "available actions" into one per-item table.
-- Backfill first, then tighten description to NOT NULL (pre-release feature, no real data yet).
UPDATE "pipeline_sensors" SET "description" = 'context' WHERE "description" IS NULL;

-- AlterTable
ALTER TABLE "pipeline_sensors"
  ALTER COLUMN "description" SET NOT NULL,
  ADD COLUMN "inject_as_sensor" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "inject_as_action" BOOLEAN NOT NULL DEFAULT false;
