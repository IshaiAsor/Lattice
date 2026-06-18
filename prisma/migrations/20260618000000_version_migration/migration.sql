ALTER TABLE "user_devices" ADD COLUMN "current_firmware_version" VARCHAR(64);
ALTER TABLE "user_device_actions" ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'active';
