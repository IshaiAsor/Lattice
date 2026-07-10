-- Structurally separate fault readings from real readings in sensor_history.
-- A fault (device published {"error":"read_failed",...}) is now value=NULL, is_error=true,
-- error_code=<code>, instead of the raw JSON envelope living in the value column.
-- No backfill: existing error-envelope rows keep their text value and is_error=false.
ALTER TABLE "sensor_history" ALTER COLUMN "value" DROP NOT NULL;
ALTER TABLE "sensor_history" ADD COLUMN "is_error" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sensor_history" ADD COLUMN "error_code" VARCHAR(100);
