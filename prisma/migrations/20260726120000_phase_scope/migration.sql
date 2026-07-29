-- Phase-scoped automations (F10 follow-up).
--
-- Each blueprint automation and its derived counterpart gains a phase_scope: the set of phase
-- keys it is active in. Empty (the default) means every phase — so this is inert for every
-- existing row and preserves today's "active in all phases" behavior. A non-empty set makes the
-- automation live only while the instance's current phase key is in it; the gate is read at
-- evaluation time, so a phase change never rewrites these rows.
--
-- text[] with a '{}' default matches the existing schedule_days int[] treatment — a typed array,
-- not JSON.

-- Blueprint templates (authored in the admin builder).
ALTER TABLE "blueprint_rule_templates"     ADD COLUMN "phase_scope" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "blueprint_scene_templates"    ADD COLUMN "phase_scope" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "blueprint_pipeline_templates" ADD COLUMN "phase_scope" TEXT[] NOT NULL DEFAULT '{}';

-- Derived automations (written by derive/reconcile, read by the engines).
ALTER TABLE "user_rules" ADD COLUMN "phase_scope" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "scenes"     ADD COLUMN "phase_scope" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "pipelines"  ADD COLUMN "phase_scope" TEXT[] NOT NULL DEFAULT '{}';
