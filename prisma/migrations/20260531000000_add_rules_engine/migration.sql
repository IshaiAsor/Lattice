CREATE TABLE "user_rules" (
  "id"                 SERIAL PRIMARY KEY,
  "user_id"            INTEGER NOT NULL,
  "name"               VARCHAR(255) NOT NULL,
  "enabled"            BOOLEAN NOT NULL DEFAULT true,
  "condition_operator" VARCHAR(3) NOT NULL DEFAULT 'AND',
  "cooldown_seconds"   INTEGER NOT NULL DEFAULT 60,
  "last_triggered"     TIMESTAMP(6),
  "created_at"         TIMESTAMP(6) DEFAULT NOW(),
  "updated_at"         TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "user_rules_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "user_rule_conditions" (
  "id"             SERIAL PRIMARY KEY,
  "rule_id"        INTEGER NOT NULL,
  "condition_type" VARCHAR(20) NOT NULL,
  "parameters"     JSONB NOT NULL,
  CONSTRAINT "user_rule_conditions_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "user_rules"("id") ON DELETE CASCADE
);

CREATE TABLE "user_rule_actions" (
  "id"                    SERIAL PRIMARY KEY,
  "rule_id"               INTEGER NOT NULL,
  "user_device_action_id" INTEGER NOT NULL,
  "target_state"          VARCHAR(255) NOT NULL,
  "delay_seconds"         INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "user_rule_actions_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "user_rules"("id") ON DELETE CASCADE,
  CONSTRAINT "user_rule_actions_uda_fkey"
    FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE CASCADE
);
