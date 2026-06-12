-- Add unique constraint on (user_device_model_id, action_key) to support
-- idempotent upsert when ESP32 self-reports capabilities during provisioning.
CREATE UNIQUE INDEX IF NOT EXISTS "user_action_defs_user_device_model_id_action_key_key"
  ON "user_action_defs"("user_device_model_id", "action_key");
