-- Multi-instance sealed-template actions.
-- A capability may now appear more than once per template (e.g. 8 i2c_socket_8 channels), so the
-- entry's own mqtt_action_name — not capability_key — is the per-template unique key. This mirrors
-- user_device_actions, whose mqtt_action_name is the base capability name for the first instance
-- and <base>_2/_3/… for repeats.

-- Add the per-instance routing verb; backfill existing rows from capability_key (safe: unique per
-- template today), then enforce NOT NULL.
ALTER TABLE "sealed_template_entries" ADD COLUMN "mqtt_action_name" VARCHAR(64);
UPDATE "sealed_template_entries" SET "mqtt_action_name" = "capability_key" WHERE "mqtt_action_name" IS NULL;
ALTER TABLE "sealed_template_entries" ALTER COLUMN "mqtt_action_name" SET NOT NULL;

-- Swap the uniqueness constraint from capability_key to mqtt_action_name.
DROP INDEX "sealed_template_entries_template_id_capability_key_key";
CREATE UNIQUE INDEX "sealed_template_entries_template_id_mqtt_action_name_key" ON "sealed_template_entries"("template_id", "mqtt_action_name");
