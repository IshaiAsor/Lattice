-- When the pending OTA was dispatched.
--
-- `pending_firmware_version` already records THAT an update is in flight, but not since when —
-- so "an update is already running, don't dispatch another" was a rule the platform could not
-- express safely. Without an expiry it would be a permanent lock: a device that goes offline
-- mid-download never acks and never reports the new version, so its pending update would never
-- clear and the device could never be updated again.
--
-- Set beside pending_firmware_version on dispatch, cleared with it on confirm or on the failure
-- rollback. Nullable with no backfill: an existing pending row (there is at most one per device,
-- and only for an update dispatched before this migration) reads as NULL = no known dispatch
-- time = already expired, which is the permissive answer and the right one for an update old
-- enough to predate the column.

ALTER TABLE "user_devices" ADD COLUMN "pending_since" TIMESTAMP(6);
