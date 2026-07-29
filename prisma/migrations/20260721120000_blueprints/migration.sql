-- Blueprints (F10.2): admin-authored descriptions of a whole multi-device setup, and the
-- per-user instances derived from them.
--
--   definition  blueprints → slots / params / phases / *_templates   (admin, versioned)
--   instance    blueprint_instances → bindings / overrides           (user, live)
--
-- Slots reference a released sealed_template (RESTRICT — a template with live slots must not
-- vanish). Template rows address devices as (slot_key, action_name) instead of by row id and
-- carry a `key` that is the reconcile identity across a v2 release. Value columns hold either a
-- literal or an `@param.x` / `@phase.x` reference resolved at evaluation time, which is what
-- keeps reconcile, phase advance and user overrides writing to disjoint places.

-- CreateTable
CREATE TABLE "blueprints" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "context_notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_slots" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "min_count" INTEGER NOT NULL DEFAULT 1,
    "max_count" INTEGER NOT NULL DEFAULT 1,
    "sealed_template_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_params" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "default_value" VARCHAR(100) NOT NULL,
    "unit" VARCHAR(20),
    "user_tunable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_params_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_phases" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "duration_value" INTEGER,
    "duration_unit" VARCHAR(10),
    "auto_advance" BOOLEAN NOT NULL DEFAULT false,
    "context_notes" TEXT,

    CONSTRAINT "blueprint_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_phase_targets" (
    "id" SERIAL NOT NULL,
    "phase_id" INTEGER NOT NULL,
    "param_key" VARCHAR(64) NOT NULL,
    "value" VARCHAR(100) NOT NULL,

    CONSTRAINT "blueprint_phase_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_scene_templates" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_scene_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_scene_template_members" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "slot_key" VARCHAR(64) NOT NULL,
    "action_name" VARCHAR(64) NOT NULL,
    "target_state" VARCHAR(255) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "delay_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_scene_template_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_rule_templates" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "condition_operator" VARCHAR(3) NOT NULL DEFAULT 'AND',
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 60,

    CONSTRAINT "blueprint_rule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_rule_template_conditions" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "condition_type" VARCHAR(20) NOT NULL,
    "slot_key" VARCHAR(64),
    "action_name" VARCHAR(64),
    "operator" VARCHAR(5),
    "threshold_value" VARCHAR(100),
    "status_value" VARCHAR(20),
    "schedule_time" VARCHAR(5),
    "schedule_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "blueprint_rule_template_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_rule_template_actions" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "slot_key" VARCHAR(64) NOT NULL,
    "action_name" VARCHAR(64) NOT NULL,
    "target_state" VARCHAR(255) NOT NULL,
    "delay_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_rule_template_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_pipeline_templates" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "blueprint_pipeline_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_pipeline_template_sensors" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "group_name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "slot_key" VARCHAR(64) NOT NULL,
    "action_name" VARCHAR(64) NOT NULL,
    "inject_as_sensor" BOOLEAN NOT NULL DEFAULT true,
    "inject_as_action" BOOLEAN NOT NULL DEFAULT false,
    "min_value" VARCHAR(50),
    "max_value" VARCHAR(50),
    "compression" VARCHAR(20) NOT NULL DEFAULT 'average',
    "window_minutes" INTEGER NOT NULL DEFAULT 60,
    "n" INTEGER,

    CONSTRAINT "blueprint_pipeline_template_sensors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_pipeline_template_stages" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "ml_model_id" INTEGER,
    -- Typed columns per `kind`, not a JSON config blob (see prisma/SCHEMA.md invariants):
    --   infer -> prompt_template, command_exec -> notify / execute_condition.
    "prompt_template" TEXT,
    "notify" VARCHAR(20),
    "execute_condition" VARCHAR(20),

    CONSTRAINT "blueprint_pipeline_template_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_pipeline_template_triggers" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "trigger_type" VARCHAR(20) NOT NULL,
    "slot_key" VARCHAR(64),
    "action_name" VARCHAR(64),
    "operator" VARCHAR(5),
    "threshold_value" VARCHAR(100),
    "schedule_cron" VARCHAR(100),
    "min_interval_sec" INTEGER,

    CONSTRAINT "blueprint_pipeline_template_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_instances" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "blueprint_version" INTEGER NOT NULL,
    "area_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "current_phase_id" INTEGER,
    "phase_started_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprint_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_slot_bindings" (
    "id" SERIAL NOT NULL,
    "instance_id" INTEGER NOT NULL,
    "slot_key" VARCHAR(64) NOT NULL,
    "user_device_id" INTEGER NOT NULL,
    "auto_bound" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "blueprint_slot_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_param_overrides" (
    "id" SERIAL NOT NULL,
    "instance_id" INTEGER NOT NULL,
    "param_key" VARCHAR(64) NOT NULL,
    "value" VARCHAR(100) NOT NULL,

    CONSTRAINT "blueprint_param_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blueprints_key_key" ON "blueprints"("key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_slots_blueprint_id_key_key" ON "blueprint_slots"("blueprint_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_params_blueprint_id_key_key" ON "blueprint_params"("blueprint_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_phases_blueprint_id_key_key" ON "blueprint_phases"("blueprint_id", "key");

-- CreateIndex
CREATE INDEX "blueprint_phases_blueprint_id_ordinal_idx" ON "blueprint_phases"("blueprint_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_phase_targets_phase_id_param_key_key" ON "blueprint_phase_targets"("phase_id", "param_key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_scene_templates_blueprint_id_key_key" ON "blueprint_scene_templates"("blueprint_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_scene_template_members_template_id_slot_key_action_key" ON "blueprint_scene_template_members"("template_id", "slot_key", "action_name");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_rule_templates_blueprint_id_key_key" ON "blueprint_rule_templates"("blueprint_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_pipeline_templates_blueprint_id_key_key" ON "blueprint_pipeline_templates"("blueprint_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_pipeline_template_sensors_template_id_slot_key_act_key" ON "blueprint_pipeline_template_sensors"("template_id", "slot_key", "action_name");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_pipeline_template_stages_template_id_ordinal_key" ON "blueprint_pipeline_template_stages"("template_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_instances_user_id_name_key" ON "blueprint_instances"("user_id", "name");

-- CreateIndex
CREATE INDEX "blueprint_instances_blueprint_id_idx" ON "blueprint_instances"("blueprint_id");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_slot_bindings_instance_id_slot_key_user_device_id_key" ON "blueprint_slot_bindings"("instance_id", "slot_key", "user_device_id");

-- CreateIndex
CREATE UNIQUE INDEX "blueprint_param_overrides_instance_id_param_key_key" ON "blueprint_param_overrides"("instance_id", "param_key");

-- AddForeignKey
ALTER TABLE "blueprint_slots" ADD CONSTRAINT "blueprint_slots_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_slots" ADD CONSTRAINT "blueprint_slots_sealed_template_id_fkey" FOREIGN KEY ("sealed_template_id") REFERENCES "sealed_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_params" ADD CONSTRAINT "blueprint_params_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_phases" ADD CONSTRAINT "blueprint_phases_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_phase_targets" ADD CONSTRAINT "blueprint_phase_targets_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "blueprint_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_scene_templates" ADD CONSTRAINT "blueprint_scene_templates_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_scene_template_members" ADD CONSTRAINT "blueprint_scene_template_members_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "blueprint_scene_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_rule_templates" ADD CONSTRAINT "blueprint_rule_templates_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_rule_template_conditions" ADD CONSTRAINT "blueprint_rule_template_conditions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "blueprint_rule_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_rule_template_actions" ADD CONSTRAINT "blueprint_rule_template_actions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "blueprint_rule_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_pipeline_templates" ADD CONSTRAINT "blueprint_pipeline_templates_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_pipeline_template_sensors" ADD CONSTRAINT "blueprint_pipeline_template_sensors_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "blueprint_pipeline_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_pipeline_template_stages" ADD CONSTRAINT "blueprint_pipeline_template_stages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "blueprint_pipeline_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_pipeline_template_stages" ADD CONSTRAINT "blueprint_pipeline_template_stages_ml_model_id_fkey" FOREIGN KEY ("ml_model_id") REFERENCES "ml_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_pipeline_template_triggers" ADD CONSTRAINT "blueprint_pipeline_template_triggers_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "blueprint_pipeline_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_instances" ADD CONSTRAINT "blueprint_instances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_instances" ADD CONSTRAINT "blueprint_instances_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_instances" ADD CONSTRAINT "blueprint_instances_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_instances" ADD CONSTRAINT "blueprint_instances_current_phase_id_fkey" FOREIGN KEY ("current_phase_id") REFERENCES "blueprint_phases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_slot_bindings" ADD CONSTRAINT "blueprint_slot_bindings_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "blueprint_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_slot_bindings" ADD CONSTRAINT "blueprint_slot_bindings_user_device_id_fkey" FOREIGN KEY ("user_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_param_overrides" ADD CONSTRAINT "blueprint_param_overrides_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "blueprint_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Provenance on derived entities. blueprint_key names the template that produced the row (the
-- reconcile identity); user_modified is set by the ordinary update paths and makes reconcile
-- skip the row and surface it as drift. SET NULL so deleting an instance orphans rather than
-- destroys the automations a user may still want.

-- AlterTable
ALTER TABLE "user_rules" ADD COLUMN "blueprint_instance_id" INTEGER,
                         ADD COLUMN "blueprint_key" VARCHAR(64),
                         ADD COLUMN "user_modified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "scenes" ADD COLUMN "blueprint_instance_id" INTEGER,
                     ADD COLUMN "blueprint_key" VARCHAR(64),
                     ADD COLUMN "user_modified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN "blueprint_instance_id" INTEGER,
                        ADD COLUMN "blueprint_key" VARCHAR(64),
                        ADD COLUMN "user_modified" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "user_rules_blueprint_instance_id_idx" ON "user_rules"("blueprint_instance_id");

-- CreateIndex
CREATE INDEX "scenes_blueprint_instance_id_idx" ON "scenes"("blueprint_instance_id");

-- CreateIndex
CREATE INDEX "pipelines_blueprint_instance_id_idx" ON "pipelines"("blueprint_instance_id");

-- AddForeignKey
ALTER TABLE "user_rules" ADD CONSTRAINT "user_rules_blueprint_instance_id_fkey" FOREIGN KEY ("blueprint_instance_id") REFERENCES "blueprint_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_blueprint_instance_id_fkey" FOREIGN KEY ("blueprint_instance_id") REFERENCES "blueprint_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_blueprint_instance_id_fkey" FOREIGN KEY ("blueprint_instance_id") REFERENCES "blueprint_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
