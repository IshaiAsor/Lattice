-- Per-phase user overrides (F10.11).
--
-- A user override was instance-wide, so it won in every phase: correcting one phase and opting out
-- of the whole schedule were the same act. `phase_key` separates them — "" keeps today's meaning
-- (every phase), a phase key scopes the value to that phase alone.
--
-- Backfill is the empty string, so every existing row keeps resolving exactly as it does now.

ALTER TABLE "blueprint_param_overrides"
    ADD COLUMN "phase_key" VARCHAR(64) NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "blueprint_param_overrides_instance_id_param_key_key";

CREATE UNIQUE INDEX "blueprint_param_overrides_instance_id_param_key_phase_key_key"
    ON "blueprint_param_overrides" ("instance_id", "param_key", "phase_key");
