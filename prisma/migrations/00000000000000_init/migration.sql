-- Lattice Platform — schema v2.2 — single consolidated init migration

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "BlueprintStatus"   AS ENUM ('draft', 'published');
CREATE TYPE "StageKind"         AS ENUM ('vlm', 'sensor_digest', 'llm', 'command_exec');
CREATE TYPE "TriggerKind"       AS ENUM ('telemetry', 'schedule', 'rule');
CREATE TYPE "RuleActionKind"    AS ENUM ('set_state', 'run_pipeline');
CREATE TYPE "RuleActionScope"   AS ENUM ('instance', 'capability', 'group');

-- ─── Identity ────────────────────────────────────────────────────────────────

CREATE TABLE "users" (
  "id"                  SERIAL PRIMARY KEY,
  "user_type"           INTEGER NOT NULL DEFAULT 0,
  "role"                VARCHAR(50) NOT NULL DEFAULT 'user',
  "user_name"           VARCHAR(255) UNIQUE,
  "password"            VARCHAR(255),
  "google_id"           VARCHAR(255) UNIQUE,
  "email"               VARCHAR(255) NOT NULL UNIQUE,
  "full_name"           VARCHAR(255),
  "profile_picture_url" TEXT,
  "created_at"          TIMESTAMPTZ(6) DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) DEFAULT NOW()
);

CREATE TABLE "user_login_audit" (
  "id"         SERIAL PRIMARY KEY,
  "user_id"    INTEGER NOT NULL,
  "login_at"   TIMESTAMPTZ(6) DEFAULT NOW(),
  "ip_address" VARCHAR(100),
  CONSTRAINT "ula_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "mqtt_user" (
  "id"            SERIAL PRIMARY KEY,
  "username"      VARCHAR(100) NOT NULL UNIQUE,
  "password_hash" VARCHAR(100) NOT NULL,
  "is_superuser"  BOOLEAN DEFAULT false,
  "created_at"    TIMESTAMP(6) DEFAULT NOW()
);

-- ─── Capability vocab ─────────────────────────────────────────────────────────

CREATE TABLE "google_action_types" (
  "id"         SERIAL PRIMARY KEY,
  "key"        VARCHAR(255) NOT NULL UNIQUE,
  "name"       VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(6) DEFAULT NOW()
);

CREATE TABLE "google_traits" (
  "id"         SERIAL PRIMARY KEY,
  "key"        VARCHAR(255) NOT NULL UNIQUE,
  "name"       VARCHAR(255) NOT NULL,
  "params"     JSONB,
  "created_at" TIMESTAMP(6) DEFAULT NOW()
);

-- ─── CATALOG ─────────────────────────────────────────────────────────────────

CREATE TABLE "device_models" (
  "id"           SERIAL PRIMARY KEY,
  "model_key"    VARCHAR(255),
  "version"      VARCHAR(255),
  "display_name" VARCHAR(255) NOT NULL UNIQUE,
  "created_at"   TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"   TIMESTAMP(6) DEFAULT NOW()
);

CREATE TABLE "model_actions" (
  "id"                    SERIAL PRIMARY KEY,
  "device_model_id"       INTEGER NOT NULL,
  "action_key"            VARCHAR(255) NOT NULL,
  "capability"            VARCHAR(64) NOT NULL,
  "google_action_type_id" INTEGER NOT NULL,
  "mqtt_type"             VARCHAR(255),
  "mqtt_name"             VARCHAR(255),
  "params"                JSONB,
  "pins"                  JSONB,
  "telemetry_interval_ms" INTEGER,
  CONSTRAINT "ma_device_fkey" FOREIGN KEY ("device_model_id")       REFERENCES "device_models"("id")      ON DELETE CASCADE,
  CONSTRAINT "ma_gtype_fkey"  FOREIGN KEY ("google_action_type_id") REFERENCES "google_action_types"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "model_actions_device_key_idx" ON "model_actions"("device_model_id", "action_key");

CREATE TABLE "model_action_traits" (
  "id"              SERIAL PRIMARY KEY,
  "model_action_id" INTEGER NOT NULL,
  "google_trait_id" INTEGER NOT NULL,
  CONSTRAINT "mat_action_fkey" FOREIGN KEY ("model_action_id") REFERENCES "model_actions"("id")  ON DELETE CASCADE,
  CONSTRAINT "mat_trait_fkey"  FOREIGN KEY ("google_trait_id") REFERENCES "google_traits"("id")  ON DELETE CASCADE
);
CREATE UNIQUE INDEX "model_action_traits_pair_idx" ON "model_action_traits"("model_action_id", "google_trait_id");

-- ─── ML REGISTRY ─────────────────────────────────────────────────────────────

CREATE TABLE "ml_models" (
  "id"          SERIAL PRIMARY KEY,
  "kind"        VARCHAR(20) NOT NULL,
  "name"        VARCHAR(255) NOT NULL,
  "version"     VARCHAR(50) NOT NULL,
  "description" TEXT,
  "config"      JSONB,
  "created_at"  TIMESTAMP(6) DEFAULT NOW()
);
CREATE UNIQUE INDEX "ml_models_kvv_idx" ON "ml_models"("kind", "name", "version");

-- ─── BLUEPRINT ───────────────────────────────────────────────────────────────

CREATE TABLE "blueprints" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL,
  "description" TEXT,
  "category"    VARCHAR(100),
  "created_by"  INTEGER NOT NULL,
  "status"      "BlueprintStatus" NOT NULL DEFAULT 'draft',
  "version"     INTEGER NOT NULL DEFAULT 1,
  "created_at"  TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"  TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "bp_creator_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "blueprint_device_slots" (
  "id"              SERIAL PRIMARY KEY,
  "blueprint_id"    INTEGER NOT NULL,
  "device_model_id" INTEGER NOT NULL,
  "role"            VARCHAR(255) NOT NULL,
  "min_count"       INTEGER NOT NULL DEFAULT 1,
  "max_count"       INTEGER,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "bds_bp_fkey"    FOREIGN KEY ("blueprint_id")    REFERENCES "blueprints"("id")    ON DELETE CASCADE,
  CONSTRAINT "bds_model_fkey" FOREIGN KEY ("device_model_id") REFERENCES "device_models"("id") ON DELETE RESTRICT
);

CREATE TABLE "blueprint_action_groups" (
  "id"                       SERIAL PRIMARY KEY,
  "blueprint_id"             INTEGER NOT NULL,
  "blueprint_device_slot_id" INTEGER NOT NULL,
  "name"                     VARCHAR(255) NOT NULL,
  "description"              TEXT,
  "icon"                     VARCHAR(50),
  "color"                    VARCHAR(20),
  "sort_order"               INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "bag_bp_fkey"   FOREIGN KEY ("blueprint_id")             REFERENCES "blueprints"("id")            ON DELETE CASCADE,
  CONSTRAINT "bag_slot_fkey" FOREIGN KEY ("blueprint_device_slot_id") REFERENCES "blueprint_device_slots"("id") ON DELETE CASCADE
);

CREATE TABLE "blueprint_rules" (
  "id"           SERIAL PRIMARY KEY,
  "blueprint_id" INTEGER NOT NULL,
  "name"         VARCHAR(255) NOT NULL,
  "match"        VARCHAR(3) NOT NULL DEFAULT 'AND',
  "cooldown_sec" INTEGER NOT NULL DEFAULT 60,
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "br_bp_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE
);

CREATE TABLE "blueprint_rule_conditions" (
  "id"                SERIAL PRIMARY KEY,
  "blueprint_rule_id" INTEGER NOT NULL,
  "kind"              VARCHAR(30) NOT NULL,
  "params"            JSONB NOT NULL,
  CONSTRAINT "brc_rule_fkey" FOREIGN KEY ("blueprint_rule_id") REFERENCES "blueprint_rules"("id") ON DELETE CASCADE
);

CREATE TABLE "blueprint_pipelines" (
  "id"                 SERIAL PRIMARY KEY,
  "blueprint_id"       INTEGER NOT NULL,
  "name"               VARCHAR(255) NOT NULL,
  "enabled"            BOOLEAN NOT NULL DEFAULT true,
  "trigger_kind"       "TriggerKind" NOT NULL DEFAULT 'telemetry',
  "trigger_capability" VARCHAR(64),
  "trigger_config"     JSONB,
  CONSTRAINT "bpl_bp_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE
);

CREATE TABLE "blueprint_rule_actions" (
  "id"                    SERIAL PRIMARY KEY,
  "blueprint_rule_id"     INTEGER NOT NULL,
  "kind"                  "RuleActionKind" NOT NULL DEFAULT 'set_state',
  "capability"            VARCHAR(64),
  "target_state"          VARCHAR(255),
  "blueprint_pipeline_id" INTEGER,
  "delay_sec"             INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "bra_rule_fkey"     FOREIGN KEY ("blueprint_rule_id")     REFERENCES "blueprint_rules"("id")     ON DELETE CASCADE,
  CONSTRAINT "bra_pipeline_fkey" FOREIGN KEY ("blueprint_pipeline_id") REFERENCES "blueprint_pipelines"("id") ON DELETE SET NULL
);

CREATE TABLE "blueprint_emergency_rules" (
  "id"                SERIAL PRIMARY KEY,
  "blueprint_id"      INTEGER NOT NULL,
  "name"              VARCHAR(255) NOT NULL,
  "source_capability" VARCHAR(64) NOT NULL,
  "operator"          VARCHAR(5) NOT NULL,
  "threshold"         VARCHAR(100) NOT NULL,
  "target_capability" VARCHAR(64),
  "target_state"      VARCHAR(255),
  "enabled"           BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "ber_bp_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE
);

CREATE TABLE "blueprint_pipeline_stages" (
  "id"                    SERIAL PRIMARY KEY,
  "blueprint_pipeline_id" INTEGER NOT NULL,
  "position"              INTEGER NOT NULL,
  "stage_kind"            "StageKind" NOT NULL,
  "ml_model_id"           INTEGER,
  "component_version"     VARCHAR(50),
  "config"                JSONB,
  CONSTRAINT "bpls_pipeline_fkey"  FOREIGN KEY ("blueprint_pipeline_id") REFERENCES "blueprint_pipelines"("id") ON DELETE CASCADE,
  CONSTRAINT "bpls_ml_model_fkey"  FOREIGN KEY ("ml_model_id")           REFERENCES "ml_models"("id")          ON DELETE RESTRICT
);

-- ─── USER-OWNED definitions ───────────────────────────────────────────────────

CREATE TABLE "user_device_models" (
  "id"                  SERIAL PRIMARY KEY,
  "user_id"             INTEGER NOT NULL,
  "source_blueprint_id" INTEGER,
  "source_model_id"     INTEGER,
  "model_key"           VARCHAR(255),
  "version"             VARCHAR(255),
  "display_name"        VARCHAR(255) NOT NULL,
  "created_at"          TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"          TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "udm_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "user_action_defs" (
  "id"                    SERIAL PRIMARY KEY,
  "user_device_model_id"  INTEGER NOT NULL,
  "source_action_id"      INTEGER,
  "action_key"            VARCHAR(255) NOT NULL,
  "capability"            VARCHAR(64) NOT NULL,
  "google_action_type_id" INTEGER NOT NULL,
  "mqtt_type"             VARCHAR(255),
  "mqtt_name"             VARCHAR(255),
  "params"                JSONB,
  "pins"                  JSONB,
  "telemetry_interval_ms" INTEGER,
  CONSTRAINT "uad_model_fkey" FOREIGN KEY ("user_device_model_id") REFERENCES "user_device_models"("id") ON DELETE CASCADE
);

CREATE TABLE "user_action_def_traits" (
  "id"                 SERIAL PRIMARY KEY,
  "user_action_def_id" INTEGER NOT NULL,
  "google_trait_id"    INTEGER NOT NULL,
  CONSTRAINT "uadt_def_fkey"   FOREIGN KEY ("user_action_def_id") REFERENCES "user_action_defs"("id") ON DELETE CASCADE,
  CONSTRAINT "uadt_trait_fkey" FOREIGN KEY ("google_trait_id")    REFERENCES "google_traits"("id")    ON DELETE CASCADE
);
CREATE UNIQUE INDEX "uadt_pair_idx" ON "user_action_def_traits"("user_action_def_id", "google_trait_id");

-- ─── USER instances ───────────────────────────────────────────────────────────

CREATE TABLE "user_devices" (
  "id"                   SERIAL PRIMARY KEY,
  "user_id"              INTEGER NOT NULL,
  "user_device_model_id" INTEGER NOT NULL,
  "source_blueprint_id"  INTEGER,
  "mac_id"               VARCHAR(255) UNIQUE,
  "name"                 VARCHAR(255) NOT NULL,
  "online"               BOOLEAN DEFAULT false,
  "last_seen_at"         TIMESTAMP(6) DEFAULT NOW(),
  "created_at"           TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"           TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "ud_user_fkey"  FOREIGN KEY ("user_id")              REFERENCES "users"("id")             ON DELETE CASCADE,
  CONSTRAINT "ud_model_fkey" FOREIGN KEY ("user_device_model_id") REFERENCES "user_device_models"("id") ON DELETE CASCADE
);

CREATE TABLE "user_action_groups" (
  "id"                  SERIAL PRIMARY KEY,
  "user_device_id"      INTEGER NOT NULL,
  "user_id"             INTEGER NOT NULL,
  "source_blueprint_id" INTEGER,
  "name"                VARCHAR(255) NOT NULL,
  "description"         TEXT,
  "icon"                VARCHAR(50),
  "color"               VARCHAR(20),
  "sort_order"          INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "uag_device_fkey" FOREIGN KEY ("user_device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE,
  CONSTRAINT "uag_user_fkey"   FOREIGN KEY ("user_id")         REFERENCES "users"("id")        ON DELETE CASCADE
);

CREATE TABLE "user_actions" (
  "id"                   SERIAL PRIMARY KEY,
  "user_device_id"       INTEGER NOT NULL,
  "user_action_def_id"   INTEGER NOT NULL,
  "user_action_group_id" INTEGER,
  "name"                 VARCHAR(255) NOT NULL,
  "state"                TEXT,
  "sort_order"           INTEGER NOT NULL DEFAULT 0,
  "created_at"           TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"           TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "ua_device_fkey"  FOREIGN KEY ("user_device_id")       REFERENCES "user_devices"("id")      ON DELETE CASCADE,
  CONSTRAINT "ua_def_fkey"     FOREIGN KEY ("user_action_def_id")   REFERENCES "user_action_defs"("id")  ON DELETE CASCADE,
  CONSTRAINT "ua_group_fkey"   FOREIGN KEY ("user_action_group_id") REFERENCES "user_action_groups"("id") ON DELETE SET NULL
);

-- ─── USER automation ──────────────────────────────────────────────────────────

CREATE TABLE "rules" (
  "id"                  SERIAL PRIMARY KEY,
  "user_id"             INTEGER NOT NULL,
  "source_blueprint_id" INTEGER,
  "name"                VARCHAR(255) NOT NULL,
  "match"               VARCHAR(3) NOT NULL DEFAULT 'AND',
  "cooldown_sec"        INTEGER NOT NULL DEFAULT 60,
  "enabled"             BOOLEAN NOT NULL DEFAULT true,
  "last_fired_at"       TIMESTAMP(6),
  "created_at"          TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"          TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "rules_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "rule_conditions" (
  "id"      SERIAL PRIMARY KEY,
  "rule_id" INTEGER NOT NULL,
  "kind"    VARCHAR(30) NOT NULL,
  "params"  JSONB NOT NULL,
  CONSTRAINT "rco_rule_fkey" FOREIGN KEY ("rule_id") REFERENCES "rules"("id") ON DELETE CASCADE
);

CREATE TABLE "pipelines" (
  "id"                  SERIAL PRIMARY KEY,
  "user_id"             INTEGER NOT NULL,
  "source_blueprint_id" INTEGER,
  "name"                VARCHAR(255) NOT NULL,
  "enabled"             BOOLEAN NOT NULL DEFAULT true,
  "trigger_kind"        "TriggerKind" NOT NULL DEFAULT 'telemetry',
  "trigger_capability"  VARCHAR(64),
  "trigger_config"      JSONB,
  "created_at"          TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "pl_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "rule_actions" (
  "id"             SERIAL PRIMARY KEY,
  "rule_id"        INTEGER NOT NULL,
  "kind"           "RuleActionKind" NOT NULL DEFAULT 'set_state',
  "scope"          "RuleActionScope" NOT NULL DEFAULT 'instance',
  "user_action_id" INTEGER,
  "capability"     VARCHAR(64),
  "group_id"       INTEGER,
  "target_state"   VARCHAR(255),
  "pipeline_id"    INTEGER,
  "delay_sec"      INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ra_rule_fkey"     FOREIGN KEY ("rule_id")        REFERENCES "rules"("id")              ON DELETE CASCADE,
  CONSTRAINT "ra_action_fkey"   FOREIGN KEY ("user_action_id") REFERENCES "user_actions"("id")       ON DELETE CASCADE,
  CONSTRAINT "ra_group_fkey"    FOREIGN KEY ("group_id")       REFERENCES "user_action_groups"("id") ON DELETE SET NULL,
  CONSTRAINT "ra_pipeline_fkey" FOREIGN KEY ("pipeline_id")    REFERENCES "pipelines"("id")          ON DELETE SET NULL
);

CREATE TABLE "emergency_rules" (
  "id"                    SERIAL PRIMARY KEY,
  "user_id"               INTEGER NOT NULL,
  "source_blueprint_id"   INTEGER,
  "name"                  VARCHAR(255) NOT NULL,
  "source_scope"          "RuleActionScope" NOT NULL DEFAULT 'instance',
  "source_user_action_id" INTEGER,
  "source_capability"     VARCHAR(64),
  "source_group_id"       INTEGER,
  "operator"              VARCHAR(5) NOT NULL,
  "threshold"             VARCHAR(100) NOT NULL,
  "target_scope"          "RuleActionScope" NOT NULL DEFAULT 'instance',
  "target_user_action_id" INTEGER,
  "target_capability"     VARCHAR(64),
  "target_group_id"       INTEGER,
  "target_state"          VARCHAR(255),
  "enabled"               BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "er_user_fkey"         FOREIGN KEY ("user_id")               REFERENCES "users"("id")              ON DELETE CASCADE,
  CONSTRAINT "er_src_action_fkey"   FOREIGN KEY ("source_user_action_id") REFERENCES "user_actions"("id")       ON DELETE CASCADE,
  CONSTRAINT "er_tgt_action_fkey"   FOREIGN KEY ("target_user_action_id") REFERENCES "user_actions"("id")       ON DELETE SET NULL,
  CONSTRAINT "er_src_group_fkey"    FOREIGN KEY ("source_group_id")       REFERENCES "user_action_groups"("id") ON DELETE SET NULL,
  CONSTRAINT "er_tgt_group_fkey"    FOREIGN KEY ("target_group_id")       REFERENCES "user_action_groups"("id") ON DELETE SET NULL
);

CREATE TABLE "emergency_events" (
  "id"                SERIAL PRIMARY KEY,
  "emergency_rule_id" INTEGER NOT NULL,
  "value"             VARCHAR(255) NOT NULL,
  "trace_id"          VARCHAR(36),
  "fired_at"          TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ee_rule_fkey" FOREIGN KEY ("emergency_rule_id") REFERENCES "emergency_rules"("id") ON DELETE CASCADE
);

-- ─── USER pipelines ───────────────────────────────────────────────────────────

CREATE TABLE "pipeline_stages" (
  "id"                SERIAL PRIMARY KEY,
  "pipeline_id"       INTEGER NOT NULL,
  "position"          INTEGER NOT NULL,
  "stage_kind"        "StageKind" NOT NULL,
  "ml_model_id"       INTEGER,
  "component_version" VARCHAR(50),
  "config"            JSONB,
  CONSTRAINT "pls_pipeline_fkey"  FOREIGN KEY ("pipeline_id")  REFERENCES "pipelines"("id")  ON DELETE CASCADE,
  CONSTRAINT "pls_ml_model_fkey"  FOREIGN KEY ("ml_model_id")  REFERENCES "ml_models"("id")  ON DELETE RESTRICT
);

CREATE TABLE "pipeline_runs" (
  "id"                     SERIAL PRIMARY KEY,
  "pipeline_id"            INTEGER NOT NULL,
  "trigger_user_action_id" INTEGER,
  "trace_id"               VARCHAR(36),
  "status"                 VARCHAR(20) NOT NULL,
  "input"                  JSONB,
  "output"                 JSONB,
  "started_at"             TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "finished_at"            TIMESTAMP(6),
  CONSTRAINT "pr_pipeline_fkey" FOREIGN KEY ("pipeline_id")            REFERENCES "pipelines"("id")    ON DELETE CASCADE,
  CONSTRAINT "pr_action_fkey"   FOREIGN KEY ("trigger_user_action_id") REFERENCES "user_actions"("id") ON DELETE SET NULL
);

CREATE TABLE "pipeline_run_stages" (
  "id"              SERIAL PRIMARY KEY,
  "pipeline_run_id" INTEGER NOT NULL,
  "position"        INTEGER NOT NULL,
  "stage_kind"      "StageKind" NOT NULL,
  "component"       VARCHAR(255),
  "version"         VARCHAR(50),
  "input"           JSONB,
  "output"          JSONB,
  "duration_ms"     INTEGER,
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "prs_run_fkey" FOREIGN KEY ("pipeline_run_id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE
);

-- ─── History & derivation ─────────────────────────────────────────────────────

CREATE TABLE "sensor_readings" (
  "id"             SERIAL PRIMARY KEY,
  "user_action_id" INTEGER NOT NULL,
  "value"          VARCHAR(255) NOT NULL,
  "recorded_at"    TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "sr_action_fkey" FOREIGN KEY ("user_action_id") REFERENCES "user_actions"("id") ON DELETE CASCADE
);
CREATE INDEX "sensor_readings_action_time_idx" ON "sensor_readings"("user_action_id", "recorded_at");

CREATE TABLE "user_blueprints" (
  "id"           SERIAL PRIMARY KEY,
  "user_id"      INTEGER NOT NULL,
  "blueprint_id" INTEGER NOT NULL,
  "version"      INTEGER NOT NULL,
  "derived_at"   TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ub_user_fkey"      FOREIGN KEY ("user_id")      REFERENCES "users"("id")      ON DELETE CASCADE,
  CONSTRAINT "ub_blueprint_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "user_blueprints_pair_idx" ON "user_blueprints"("user_id", "blueprint_id");
