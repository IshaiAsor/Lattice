-- Pipeline stage config: JSON blob -> typed columns.
--
-- `config` carried a small, fixed set of keys that differ by stage `kind`:
--   infer        -> prompt_template
--   command_exec -> notify, execute_condition
-- That is stable-shaped data, so it belongs in columns. JSON stays reserved for ML audit blobs
-- and model/Google metadata (the same treatment user_rule_conditions.parameters got).
--
-- Only `pipeline_stages` is altered here: it is created by 0_init, which is already applied
-- elsewhere, so its shape can only be changed by a forward migration. The blueprint-side table
-- is younger than any deployment, so its columns were folded into the migration that creates it
-- (20260721120000_blueprints) rather than being added and dropped again here.
--
-- Backfill before dropping, so existing prompts and command_exec options survive.

ALTER TABLE "pipeline_stages" ADD COLUMN "prompt_template" TEXT;
ALTER TABLE "pipeline_stages" ADD COLUMN "notify" VARCHAR(20);
ALTER TABLE "pipeline_stages" ADD COLUMN "execute_condition" VARCHAR(20);

UPDATE "pipeline_stages"
   SET "prompt_template"   = "config" ->> 'prompt_template',
       "notify"            = "config" ->> 'notify',
       "execute_condition" = "config" ->> 'execute_condition'
 WHERE "config" IS NOT NULL;

ALTER TABLE "pipeline_stages" DROP COLUMN "config";
