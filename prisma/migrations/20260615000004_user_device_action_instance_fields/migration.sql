-- Add per-instance mqtt_action_name and pins to user_device_actions.
-- mqtt_action_name: backfilled from the linked device_actions row so existing rows
--                   get the correct routing key without a fallback chain in code.
-- pins: nullable — existing rows had no per-instance pin config (used the DeviceAction template).

ALTER TABLE "user_device_actions" ADD COLUMN "mqtt_action_name" VARCHAR(64);
ALTER TABLE "user_device_actions" ADD COLUMN "pins" JSONB;

UPDATE "user_device_actions" uda
SET mqtt_action_name = da.mqtt_action_name
FROM "device_actions" da
WHERE uda.action_id = da.id;

ALTER TABLE "user_device_actions" ALTER COLUMN "mqtt_action_name" SET NOT NULL;
