/*
  Warnings:

  - You are about to drop the column `execute_user_device_action_id` on the `pipeline_stages` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "pipeline_stages" DROP CONSTRAINT "pipeline_stages_execute_user_device_action_id_fkey";

-- AlterTable
ALTER TABLE "pipeline_runs" ADD COLUMN     "is_dry_run" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sensor_overrides" JSONB,
ADD COLUMN     "trigger_type" VARCHAR(20) NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "pipeline_sensors" ADD COLUMN     "compression" VARCHAR(20) NOT NULL DEFAULT 'average',
ADD COLUMN     "n" INTEGER,
ADD COLUMN     "window_minutes" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
ALTER TABLE "pipeline_stages" DROP COLUMN "execute_user_device_action_id";

-- RenameIndex
ALTER INDEX "user_device_action_pins_user_device_action_id_capability_pin_id" RENAME TO "user_device_action_pins_user_device_action_id_capability_pi_key";
