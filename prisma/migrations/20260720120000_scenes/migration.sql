-- Scenes (F10.5): a user-named set of device actions executed on demand ("Good Night").
-- Structurally a user_rules row without conditions — firing is manual rather than
-- condition-driven. scene_members is a join table carrying the DESIRED target_state per
-- action (plus sort_order/delay_seconds for staggered execution), so unlike the exclusive
-- user_device_actions.group_id folder relation, one action can belong to many scenes.

-- CreateTable
CREATE TABLE "scenes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_members" (
    "id" SERIAL NOT NULL,
    "scene_id" INTEGER NOT NULL,
    "user_device_action_id" INTEGER NOT NULL,
    "target_state" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "delay_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scene_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scenes_user_id_name_key" ON "scenes"("user_id", "name");

-- CreateIndex
CREATE INDEX "scenes_user_id_sort_order_idx" ON "scenes"("user_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "scene_members_scene_id_user_device_action_id_key" ON "scene_members"("scene_id", "user_device_action_id");

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_members" ADD CONSTRAINT "scene_members_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_members" ADD CONSTRAINT "scene_members_user_device_action_id_fkey" FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
