-- Behavior-config as catalog-first sub-tables (unified action model, Phase 6d).
-- capability_configurations: one row per behavior a capability supports (command|interval|
--   on_demand), firmware-generated into the catalog. Per-behavior limits are typed columns.
-- user_action_configurations: one row per behavior the user enabled on their action, with the
--   chosen values (typed columns); validated against the capability's rows on save.

-- CreateTable
CREATE TABLE "capability_configurations" (
    "id" SERIAL NOT NULL,
    "capability_id" INTEGER NOT NULL,
    "behavior" VARCHAR(20) NOT NULL,
    "min_interval_ms" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_action_configurations" (
    "id" SERIAL NOT NULL,
    "user_device_action_id" INTEGER NOT NULL,
    "capability_configuration_id" INTEGER NOT NULL,
    "behavior" VARCHAR(20) NOT NULL,
    "interval_ms" INTEGER,
    "camera_resolution" VARCHAR(20),
    "camera_transport" VARCHAR(10),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_action_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capability_configurations_capability_id_behavior_key" ON "capability_configurations"("capability_id", "behavior");

-- CreateIndex
CREATE UNIQUE INDEX "user_action_configurations_user_device_action_id_behavior_key" ON "user_action_configurations"("user_device_action_id", "behavior");

-- AddForeignKey
ALTER TABLE "capability_configurations" ADD CONSTRAINT "capability_configurations_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "device_capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_action_configurations" ADD CONSTRAINT "user_action_configurations_user_device_action_id_fkey" FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_action_configurations" ADD CONSTRAINT "user_action_configurations_capability_configuration_id_fkey" FOREIGN KEY ("capability_configuration_id") REFERENCES "capability_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
