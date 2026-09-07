-- F20 — a device fault becomes something rules and pipelines can act on.
--
-- Faults were already RECORDED (digest-service writes a sensor_history row with is_error = true and
-- deliberately leaves current_state on the last good value) but could not be ACTED ON: there was no
-- condition kind and no trigger type for "this sensor is failing".
--
-- Two different things are added here and they are not the same column twice.
--
-- 1. user_device_actions.current_error_code / error_since — the OBSERVED fault, the action's live
--    state. The rules engine is a poll-over-DB evaluator: its threshold branch reads current_state,
--    not the arriving reading. A fault marker beside current_state is therefore what lets an error
--    condition be answered in the same query as every other condition it is ANDed with. It is
--    deliberately NOT derived from sensor_history — those rows are pruned by retention, so a fault
--    could otherwise disappear from under a live rule for a reason that has nothing to do with the
--    device. error_since is set only on the transition into a fault, so it measures fault DURATION
--    rather than the age of the most recent fault message; the next good reading clears both.
--
-- 2. error_code on the four config tables — the WANTED fault, part of a condition/trigger's
--    definition. NULL means "any fault", which is what both editors write today: firmware emits a
--    single code (`read_failed`), and a picker over one value would promise a choice that does not
--    exist. The column is honoured end to end now so the day a second code ships, nothing but the
--    UI has to change.
--
-- No backfill and no new kind rows: `error` is a new value of the existing condition_type /
-- trigger_type VarChar columns, which carry no enum and no check constraint. An engine that has not
-- been deployed yet simply does not recognise the kind and falls through to NOT_MET — it fails
-- closed, which is the behaviour every unknown kind already has.

ALTER TABLE "user_device_actions" ADD COLUMN "current_error_code" VARCHAR(100);
ALTER TABLE "user_device_actions" ADD COLUMN "error_since" TIMESTAMPTZ(6);

ALTER TABLE "user_rule_conditions" ADD COLUMN "error_code" VARCHAR(100);
ALTER TABLE "pipeline_triggers" ADD COLUMN "error_code" VARCHAR(100);

ALTER TABLE "blueprint_rule_template_conditions" ADD COLUMN "error_code" VARCHAR(100);
ALTER TABLE "blueprint_pipeline_template_triggers" ADD COLUMN "error_code" VARCHAR(100);
