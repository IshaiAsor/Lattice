-- Sealed devices: admin-composed templates over the shared catalog.
-- devices.is_sealed marks factory-soldered types (seeded from the firmware SEALED marker).
-- sealed_templates + targets + entries(+pins/behaviors) are the admin authoring layer: which
-- catalog capabilities to activate (by capability_key), the fixed GPIO per pin slot, and which
-- behaviors. Entries reference the catalog by key so one template resolves across a version range.

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "is_sealed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "sealed_templates" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sealed_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sealed_template_targets" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "device_type" VARCHAR(255) NOT NULL,
    "version_min" VARCHAR(64) NOT NULL,
    "version_max" VARCHAR(64) NOT NULL,

    CONSTRAINT "sealed_template_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sealed_template_entries" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "capability_key" VARCHAR(64) NOT NULL,
    "action_label" VARCHAR(255) NOT NULL,
    "default_trait_value" VARCHAR(255),
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sealed_template_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sealed_template_entry_pins" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "pin_slot_key" VARCHAR(50) NOT NULL,
    "pin_number" INTEGER NOT NULL,

    CONSTRAINT "sealed_template_entry_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sealed_template_entry_behaviors" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "behavior" VARCHAR(20) NOT NULL,
    "interval_ms" INTEGER,
    "camera_resolution" VARCHAR(20),
    "camera_transport" VARCHAR(10),

    CONSTRAINT "sealed_template_entry_behaviors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sealed_templates_name_key" ON "sealed_templates"("name");

-- CreateIndex
CREATE INDEX "sealed_template_targets_device_type_idx" ON "sealed_template_targets"("device_type");

-- CreateIndex
CREATE UNIQUE INDEX "sealed_template_entries_template_id_capability_key_key" ON "sealed_template_entries"("template_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "sealed_template_entry_pins_entry_id_pin_slot_key_key" ON "sealed_template_entry_pins"("entry_id", "pin_slot_key");

-- CreateIndex
CREATE UNIQUE INDEX "sealed_template_entry_behaviors_entry_id_behavior_key" ON "sealed_template_entry_behaviors"("entry_id", "behavior");

-- AddForeignKey
ALTER TABLE "sealed_template_targets" ADD CONSTRAINT "sealed_template_targets_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "sealed_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_template_entries" ADD CONSTRAINT "sealed_template_entries_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "sealed_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_template_entry_pins" ADD CONSTRAINT "sealed_template_entry_pins_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "sealed_template_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_template_entry_behaviors" ADD CONSTRAINT "sealed_template_entry_behaviors_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "sealed_template_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
