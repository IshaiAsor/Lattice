-- Where a device is in setup.
--
-- Provisioning deliberately creates no user_device_actions, so a freshly provisioned device is
-- inert until the user configures it. Until now that state was unrepresentable: "registered but
-- never configured" looked identical to "user removed all their actions", so the devices list
-- had no way to offer a way back into setup and an abandoned wizard was unrecoverable.
--
-- Written on the provisioning INSERT only, never on the upsert's UPDATE branch. That is what
-- keeps re-provisioning safe: a factory reset or firmware update re-runs /provision against the
-- same mac_id, and a device that already has its actions must stay 'active' rather than being
-- dragged back into the wizard. Sealed types are set to 'active' at provision time too, since
-- their actions are materialized from the admin template rather than chosen by the user.
--
-- Default 'active' with no backfill: every existing row is a device that has already been through
-- setup, so the default is also the correct historical value. Only new provisioning writes
-- 'provisioning'.

ALTER TABLE "user_devices" ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'active';
