-- Areas (F10.0): a user-createable "these devices belong together" grouping primitive,
-- independent of blueprints. Devices and the automations that act on them (scenes/rules/
-- pipelines) carry a nullable area_id; deleting an area only un-groups them (SET NULL), it
-- never deletes a device or an automation. Powers dashboard sectioning + area-scoped
-- notifications; a blueprint derive (later) creates one and fills it.

-- CreateTable
CREATE TABLE "areas" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "areas_user_id_name_key" ON "areas"("user_id", "name");

-- CreateIndex
CREATE INDEX "areas_user_id_sort_order_idx" ON "areas"("user_id", "sort_order");

-- AlterTable
ALTER TABLE "user_devices" ADD COLUMN "area_id" INTEGER;

-- AlterTable
ALTER TABLE "user_rules" ADD COLUMN "area_id" INTEGER;

-- AlterTable
ALTER TABLE "scenes" ADD COLUMN "area_id" INTEGER;

-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN "area_id" INTEGER;

-- CreateIndex
CREATE INDEX "user_devices_area_id_idx" ON "user_devices"("area_id");

-- CreateIndex
CREATE INDEX "user_rules_area_id_idx" ON "user_rules"("area_id");

-- CreateIndex
CREATE INDEX "scenes_area_id_idx" ON "scenes"("area_id");

-- CreateIndex
CREATE INDEX "pipelines_area_id_idx" ON "pipelines"("area_id");

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_rules" ADD CONSTRAINT "user_rules_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
