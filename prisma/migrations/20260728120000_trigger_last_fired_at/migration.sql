-- Per-trigger cooldown moves from a Valkey key to a durable column.
--
-- automation-worker (not digest-service) now matches pipeline sensor_threshold triggers, and its
-- min_interval_sec cooldown is enforced against this timestamp instead of a `pipeline:cooldown:<id>`
-- Valkey key. The column is authoritative and survives restarts, so a bounced worker no longer
-- resets every cooldown (the old failure mode: a restart could double-fire a rate-limited trigger).
--
-- Nullable with no backfill: a NULL last_fired_at means "never fired", which correctly lets the
-- first matching reading through for every existing trigger.

ALTER TABLE "pipeline_triggers" ADD COLUMN "last_fired_at" TIMESTAMP(6);
