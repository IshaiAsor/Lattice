-- Per-device lifecycles, and everything that follows from them (F11).
--
-- One setup holding several devices that each run their own schedule. Before this a setup had ONE
-- phase, so every device bound to a multi-device slot shared it and a single `@phase.threshold`
-- resolved to one number for all of them. That is the constraint this removes, and the rest of the
-- file is what removing it costs: somewhere to put the schedules, a way to choose one per device,
-- a way to say which devices an automation covers, and a way to say what ends a phase.
--
-- Written as one migration because it was built as one change and never released in pieces — the
-- intermediate states (phases under a profile but no binding lifecycle; a fan-out mode with no
-- selector) are not states any database was ever in, and splitting the file would only invite
-- someone to apply half of it.
--
-- Sections, in dependency order:
--
--   1. Lifecycles, and a lifecycle per bound device
--   2. The questions a blueprint asks
--   3. Setups that schedule nothing
--   4. Which devices an automation covers
--   5. What ends a phase
--   6. Who disabled this, and one device one setup
--   7. How long the device should hold an action
--   8. Schedules that repeat inside a window
--   9. The clock a schedule is read against
--  10. Every command sent to a device


-- ══ Lifecycles, and a lifecycle per bound device ──────────────────────────

-- Profiles and per-binding lifecycles (F11.1).
--
-- A setup could only ever be in ONE phase, so every device bound to a multi-device slot shared it.
-- One setup holding devices on independent schedules needs a lifecycle per binding, which means two
-- moves:
--
--   1. Phases stop hanging off the blueprint and hang off a PROFILE — a named lifecycle that a
--      binding follows. Every existing blueprint gets one implicit profile holding exactly the
--      phases it has now, so the F10 shape becomes the one-profile case of the new one rather than
--      a second code path.
--   2. A BINDING gains what the instance already had: a profile, a current phase, a clock and a
--      lifecycle state. That is what gives one bound device a schedule of its own.
--
-- Nothing existing changes behaviour: `blueprint_slots.profiled` defaults false, so no binding
-- picks a profile, no binding runs its own lifecycle, and every instance keeps the phase columns it
-- has today.

-- ─── Profiles ────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "blueprint_profiles" (
    "id"           SERIAL       NOT NULL,
    "blueprint_id" INTEGER      NOT NULL,
    "key"          VARCHAR(64)  NOT NULL,
    "label"        VARCHAR(255) NOT NULL,
    "sort_order"   INTEGER      NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_profiles_blueprint_id_key_key"
    ON "blueprint_profiles" ("blueprint_id", "key");

ALTER TABLE "blueprint_profiles"
    ADD CONSTRAINT "blueprint_profiles_blueprint_id_fkey"
    FOREIGN KEY ("blueprint_id") REFERENCES "blueprints" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One implicit profile per blueprint that has phases today. `default` is a reserved-looking but
-- ordinary key; validation forbids a user authoring a second profile with it.
INSERT INTO "blueprint_profiles" ("blueprint_id", "key", "label", "sort_order")
SELECT DISTINCT b."id", 'default', 'Default', 0
FROM "blueprints" b
WHERE EXISTS (SELECT 1 FROM "blueprint_phases" p WHERE p."blueprint_id" = b."id");

-- ─── Phases move under a profile ─────────────────────────────────────────────────────────────

ALTER TABLE "blueprint_phases" ADD COLUMN "profile_id" INTEGER;

UPDATE "blueprint_phases" ph
SET "profile_id" = pr."id"
FROM "blueprint_profiles" pr
WHERE pr."blueprint_id" = ph."blueprint_id" AND pr."key" = 'default';

ALTER TABLE "blueprint_phases" ALTER COLUMN "profile_id" SET NOT NULL;

DROP INDEX IF EXISTS "blueprint_phases_blueprint_id_key_key";
DROP INDEX IF EXISTS "blueprint_phases_blueprint_id_ordinal_idx";
ALTER TABLE "blueprint_phases" DROP CONSTRAINT IF EXISTS "blueprint_phases_blueprint_id_fkey";
ALTER TABLE "blueprint_phases" DROP COLUMN "blueprint_id";

CREATE UNIQUE INDEX "blueprint_phases_profile_id_key_key"
    ON "blueprint_phases" ("profile_id", "key");
CREATE INDEX "blueprint_phases_profile_id_ordinal_idx"
    ON "blueprint_phases" ("profile_id", "ordinal");

ALTER TABLE "blueprint_phases"
    ADD CONSTRAINT "blueprint_phases_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "blueprint_profiles" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── A profiled slot; a binding with a lifecycle of its own ──────────────────────────────────

ALTER TABLE "blueprint_slots"
    ADD COLUMN "profiled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "blueprint_slot_bindings"
    ADD COLUMN "label"            VARCHAR(255),
    ADD COLUMN "profile_key"      VARCHAR(64),
    ADD COLUMN "lifecycle_state"  VARCHAR(20) NOT NULL DEFAULT 'not_started',
    ADD COLUMN "current_phase_id" INTEGER,
    ADD COLUMN "phase_started_at" TIMESTAMP(6);

ALTER TABLE "blueprint_slot_bindings"
    ADD CONSTRAINT "blueprint_slot_bindings_current_phase_id_fkey"
    FOREIGN KEY ("current_phase_id") REFERENCES "blueprint_phases" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Per-binding time banks and overrides ────────────────────────────────────────────────────
--
-- Sibling tables rather than a nullable binding_id on the instance-level ones: Postgres treats
-- NULLs as distinct in a unique index, so a NULL component would admit duplicate rows, and Prisma's
-- upsert needs a compound unique it can name.

CREATE TABLE "blueprint_binding_phase_state" (
    "id"              SERIAL       NOT NULL,
    "binding_id"      INTEGER      NOT NULL,
    "phase_key"       VARCHAR(64)  NOT NULL,
    "accrued_seconds" INTEGER      NOT NULL DEFAULT 0,
    "last_exited_at"  TIMESTAMP(6),
    "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprint_binding_phase_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_binding_phase_state_binding_id_phase_key_key"
    ON "blueprint_binding_phase_state" ("binding_id", "phase_key");

ALTER TABLE "blueprint_binding_phase_state"
    ADD CONSTRAINT "blueprint_binding_phase_state_binding_id_fkey"
    FOREIGN KEY ("binding_id") REFERENCES "blueprint_slot_bindings" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blueprint_binding_param_overrides" (
    "id"         SERIAL       NOT NULL,
    "binding_id" INTEGER      NOT NULL,
    "param_key"  VARCHAR(64)  NOT NULL,
    "phase_key"  VARCHAR(64)  NOT NULL DEFAULT '',
    "value"      VARCHAR(100) NOT NULL,

    CONSTRAINT "blueprint_binding_param_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_binding_param_overrides_binding_id_param_key_phase_key"
    ON "blueprint_binding_param_overrides" ("binding_id", "param_key", "phase_key");

ALTER TABLE "blueprint_binding_param_overrides"
    ADD CONSTRAINT "blueprint_binding_param_overrides_binding_id_fkey"
    FOREIGN KEY ("binding_id") REFERENCES "blueprint_slot_bindings" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Template fan-out, and which binding a derived row belongs to ────────────────────────────

ALTER TABLE "blueprint_scene_templates"
    ADD COLUMN "fan_out"          VARCHAR(20) NOT NULL DEFAULT 'combined',
    ADD COLUMN "fan_out_slot_key" VARCHAR(64);
ALTER TABLE "blueprint_rule_templates"
    ADD COLUMN "fan_out"          VARCHAR(20) NOT NULL DEFAULT 'combined',
    ADD COLUMN "fan_out_slot_key" VARCHAR(64);
ALTER TABLE "blueprint_pipeline_templates"
    ADD COLUMN "fan_out"          VARCHAR(20) NOT NULL DEFAULT 'combined',
    ADD COLUMN "fan_out_slot_key" VARCHAR(64);

-- SetNull, matching blueprint_instance_id: losing the binding must orphan the automation, not
-- delete work the user may have edited.
ALTER TABLE "user_rules" ADD COLUMN "blueprint_binding_id" INTEGER;
ALTER TABLE "scenes"     ADD COLUMN "blueprint_binding_id" INTEGER;
ALTER TABLE "pipelines"  ADD COLUMN "blueprint_binding_id" INTEGER;

ALTER TABLE "user_rules"
    ADD CONSTRAINT "user_rules_blueprint_binding_id_fkey"
    FOREIGN KEY ("blueprint_binding_id") REFERENCES "blueprint_slot_bindings" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scenes"
    ADD CONSTRAINT "scenes_blueprint_binding_id_fkey"
    FOREIGN KEY ("blueprint_binding_id") REFERENCES "blueprint_slot_bindings" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pipelines"
    ADD CONSTRAINT "pipelines_blueprint_binding_id_fkey"
    FOREIGN KEY ("blueprint_binding_id") REFERENCES "blueprint_slot_bindings" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ══ The questions a blueprint asks ────────────────────────────────────────

-- The blueprint's dynamic form (F11.6).
--
-- A blueprint author needs to ask the user things the slots and params cannot express — what is
-- growing in this pot, when it was planted, which variety. Params are values the *system* tunes
-- across phases; a field is a fact the user states once, so it is a separate declaration with its
-- own reference kind (`@field.plant`) and no phase precedence.
--
-- The load-bearing detail is `blueprint_field_options.profile_key`: one question sets both facts,
-- so "What are you growing? → Cherokee Purple" stores the descriptive answer AND puts that pot on
-- the `fruiting` lifecycle. Two pots can then share a profile and still read as different plants.
--
-- Purely additive: a blueprint that declares no fields asks nothing and behaves exactly as before.

CREATE TABLE "blueprint_fields" (
    "id"            SERIAL       NOT NULL,
    "blueprint_id"  INTEGER      NOT NULL,
    "key"           VARCHAR(64)  NOT NULL,
    "label"         VARCHAR(255) NOT NULL,
    "help_text"     TEXT,
    "input_type"    VARCHAR(20)  NOT NULL DEFAULT 'text',
    "scope"         VARCHAR(20)  NOT NULL DEFAULT 'setup',
    "slot_key"      VARCHAR(64),
    "required"      BOOLEAN      NOT NULL DEFAULT false,
    "default_value" VARCHAR(500),
    "sort_order"    INTEGER      NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_fields_blueprint_id_key_key"
    ON "blueprint_fields" ("blueprint_id", "key");

ALTER TABLE "blueprint_fields"
    ADD CONSTRAINT "blueprint_fields_blueprint_id_fkey"
    FOREIGN KEY ("blueprint_id") REFERENCES "blueprints" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blueprint_field_options" (
    "id"          SERIAL       NOT NULL,
    "field_id"    INTEGER      NOT NULL,
    "value"       VARCHAR(255) NOT NULL,
    "label"       VARCHAR(255) NOT NULL,
    "profile_key" VARCHAR(64),
    "sort_order"  INTEGER      NOT NULL DEFAULT 0,

    CONSTRAINT "blueprint_field_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_field_options_field_id_value_key"
    ON "blueprint_field_options" ("field_id", "value");

ALTER TABLE "blueprint_field_options"
    ADD CONSTRAINT "blueprint_field_options_field_id_fkey"
    FOREIGN KEY ("field_id") REFERENCES "blueprint_fields" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── The answers ─────────────────────────────────────────────────────────────────────────────
--
-- Two sibling tables rather than one with a nullable binding_id: Postgres treats NULLs as distinct
-- in a unique index, so (instance_id, NULL, field_key) would admit duplicates. Same reasoning as
-- blueprint_binding_phase_state.

CREATE TABLE "blueprint_instance_field_values" (
    "id"          SERIAL       NOT NULL,
    "instance_id" INTEGER      NOT NULL,
    "field_key"   VARCHAR(64)  NOT NULL,
    "value"       VARCHAR(500) NOT NULL,

    CONSTRAINT "blueprint_instance_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_instance_field_values_instance_id_field_key_key"
    ON "blueprint_instance_field_values" ("instance_id", "field_key");

ALTER TABLE "blueprint_instance_field_values"
    ADD CONSTRAINT "blueprint_instance_field_values_instance_id_fkey"
    FOREIGN KEY ("instance_id") REFERENCES "blueprint_instances" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blueprint_binding_field_values" (
    "id"         SERIAL       NOT NULL,
    "binding_id" INTEGER      NOT NULL,
    "field_key"  VARCHAR(64)  NOT NULL,
    "value"      VARCHAR(500) NOT NULL,

    CONSTRAINT "blueprint_binding_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_binding_field_values_binding_id_field_key_key"
    ON "blueprint_binding_field_values" ("binding_id", "field_key");

ALTER TABLE "blueprint_binding_field_values"
    ADD CONSTRAINT "blueprint_binding_field_values_binding_id_fkey"
    FOREIGN KEY ("binding_id") REFERENCES "blueprint_slot_bindings" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ══ Setups that schedule nothing ──────────────────────────────────────────

-- Static setups (F11.8).
--
-- A setup can end up with no phase track for two very different reasons, and until now they looked
-- identical from the outside:
--
--   1. Nothing in the blueprint is scheduled at all — no slot has phases. A bench controller: it
--      has devices and rules, and nothing ever advances. That is a STATIC setup, and it is what
--      this column records.
--   2. The schedules exist but belong to the individual devices (`blueprint_slots.profiled`). The
--      setup has no phase of its own because each bound device has one. That is inferred from the
--      slot and needs no column — a profiled slot cannot mean anything else.
--
-- Declared rather than derived because a half-written draft also has no phases yet, and "I have not
-- added the lifecycle yet" must not be indistinguishable from "there is no lifecycle". Publish
-- validation enforces the agreement in both directions, so the flag and the content cannot drift.
--
-- A static setup still starts and stops: pausing it holds its automations, which is meaningful with
-- or without a schedule. It simply has no phase track and no timers.

ALTER TABLE "blueprints" ADD COLUMN "is_static" BOOLEAN NOT NULL DEFAULT false;

-- Back-fill honestly: a blueprint that declares no lifecycle today IS static by this definition, so
-- say so rather than leaving it in the state publish would now reject.
UPDATE "blueprints" b
SET "is_static" = true
WHERE NOT EXISTS (SELECT 1 FROM "blueprint_profiles" p WHERE p."blueprint_id" = b."id");

-- ══ Which devices an automation covers ────────────────────────────────────

-- Which devices an automation covers (F11.9).
--
-- F11.2 gave a template two shapes over a multi-device slot: `combined` (one automation naming
-- every bound device) and `per_device` (one automation each). That covers "all" and "one" but not
-- "some" — a setup whose devices follow different lifecycles usually wants an automation that
-- applies to only a few of them, and until now the only way to say that was a `per_device`
-- automation gated by `phase_scope`, which still materialised a permanently inert copy on every
-- device that could never enter the named phase.
--
-- `fan_out_profiles` is the selector: empty means every bound device (what every existing row
-- does, hence the default), non-empty means only the devices following one of the named
-- lifecycles. It is orthogonal to `fan_out`, so all four combinations are meaningful:
--
--   combined   + []                one automation over every device       ("all, together")
--   combined   + [a, b]            one automation over that subset        ("some, together")
--   per_device + []                one automation per device              ("one each")
--   per_device + [a, b]            one automation per device in the subset ("one each, for some")
--
-- Selection is by *lifecycle*, not by device id, for two reasons. A blueprint author writes the
-- template long before the user owns any devices, so a device list is not something they could
-- name. And it stays true afterwards: a device moved onto another lifecycle joins and leaves the
-- right automations by itself, where a stored device list would quietly go stale.

ALTER TABLE "blueprint_scene_templates" ADD COLUMN "fan_out_profiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "blueprint_rule_templates" ADD COLUMN "fan_out_profiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "blueprint_pipeline_templates" ADD COLUMN "fan_out_profiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ══ What ends a phase ─────────────────────────────────────────────────────

-- What ends a phase (F11.x).
--
-- Until now a phase advanced only two ways: the elapsed-duration cron (`auto_advance`) or a person.
-- A phase should also be endable by a condition or an AI — a rule firing, or a pipeline's model
-- deciding the phase is complete. That is a *trigger* the phase owns, so it collapses the old
-- `auto_advance` boolean (which only ever meant "schedule vs not") into a four-way mode:
--
--   manual    only a person advances it (start / setPhase).       -- the old auto_advance = false
--   schedule  the elapsed-duration cron.                          -- the old auto_advance = true
--   rule      the referenced rule template's derived rule firing.
--   pipeline  the referenced pipeline template's model returning advance=true.
--
-- `advance_ref_key` names the rule/pipeline template (modes rule|pipeline); `advance_to_key` is the
-- target phase key within the SAME profile, null meaning "the next by ordinal". The decider must
-- match the phase's lifecycle level (a profiled slot's phase ⇒ a per_device automation over that
-- slot ⇒ that pot; a plain setup's phase ⇒ a combined automation ⇒ the instance) — enforced at
-- publish, not by a constraint here.

ALTER TABLE "blueprint_phases"
  ADD COLUMN "advance_mode" VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN "advance_ref_key" VARCHAR(64),
  ADD COLUMN "advance_to_key" VARCHAR(64);

-- Preserve every phase that used to auto-advance on its clock.
UPDATE "blueprint_phases" SET "advance_mode" = 'schedule' WHERE "auto_advance" = true;

ALTER TABLE "blueprint_phases" DROP COLUMN "auto_advance";

-- ══ Who disabled this, and one device one setup ───────────────────────────

-- Two invariants the code assumed and nothing enforced (final F10/F11 review).

-- ── 1. Who disabled this automation? ────────────────────────────────────────────────────────────
--
-- Reconcile disables a derived row when the blueprint stops producing it — the template was removed,
-- or (since F11.2) the device it belonged to left a multi-device slot or a lifecycle selection. It
-- had no way to tell that disable apart from a user switching the same rule off by hand, because
-- toggling `enabled` is deliberately NOT treated as drift (it is not an opinion about the rule's
-- content, so it must not make reconcile abandon the row).
--
-- The result was a silent dead end: reprofile a device away and back, and its automation stayed
-- disabled forever while reconcile reported the row as "updated". This column records the author of
-- the disable, so reconcile restores exactly what it switched off and never touches the user's.

ALTER TABLE "user_rules" ADD COLUMN "disabled_by_reconcile" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pipelines"  ADD COLUMN "disabled_by_reconcile" BOOLEAN NOT NULL DEFAULT false;

-- Back-fill honestly: nothing on the way in can be attributed to reconcile, so every existing
-- disabled row is treated as the user's. Reconcile will re-disable (and then own) any that its
-- blueprint no longer produces on the next pass.

-- ── 2. A device belongs to at most one setup ────────────────────────────────────────────────────
--
-- Derive already refuses a device another setup holds, but that check reads a snapshot taken well
-- before the write transaction opens, and no constraint backed it: the existing unique is
-- (instance_id, slot_key, user_device_id), which is scoped to one setup and says nothing across
-- setups. Two concurrent derives could therefore bind the same board twice and leave two setups
-- each believing they own it — with the "already part of another setup" message permanently wrong
-- from then on.
--
-- One device fills one slot of one setup, so a plain unique index states it exactly. It also
-- subsumes the composite above for the cross-setup case; the composite stays because it is what
-- names the row for upserts.

CREATE UNIQUE INDEX "blueprint_slot_bindings_user_device_id_key"
    ON "blueprint_slot_bindings" ("user_device_id");

-- ══ How long the device should hold an action ────────────────────────────────

-- Let an action say how long the device should hold it.
--
-- The firmware has always been able to do this: `BaseCommandAction::applyAction(action, durationMs)`
-- arms a timer and its loop returns the pin to rest when the duration elapses. The simulator mirrors
-- it, and the queue payload already carries a `duration` field through to MQTT. The only thing
-- missing was a column to put it in, so the dispatch hardcoded `duration: '*'` and every automation
-- that wanted "on for a while" had to say it as TWO actions — one ON, one OFF behind a delay.
--
-- That workaround puts the timer in automation-worker's memory (a `setTimeout`), so a restart inside
-- the window loses the close and leaves the actuator on. For a valve that is a flood. The device's
-- own timer cannot be lost that way, which is why the duration belongs on the action rather than in
-- a second row.
--
-- Nullable, not defaulted: null means "hold until something else changes it", which is exactly what
-- every action written before today does, so nothing changes behaviour on the way in.

ALTER TABLE "user_rule_actions" ADD COLUMN "duration_seconds" INTEGER;
ALTER TABLE "scene_members"     ADD COLUMN "duration_seconds" INTEGER;

-- …and the blueprint templates they are derived from, so a published blueprint can carry it.
ALTER TABLE "blueprint_rule_template_actions"  ADD COLUMN "duration_seconds" INTEGER;
ALTER TABLE "blueprint_scene_template_members" ADD COLUMN "duration_seconds" INTEGER;

-- ══ Schedules that repeat inside a window ────────────────────────────────────────

-- A schedule matched ONE minute of the day: `schedule_time` and nothing else. So "on for 30 seconds
-- every 10 minutes between 06:00 and 17:30" — an ordinary thing to want from an irrigation valve or
-- a fan — was sixty-nine separate rules.
--
-- The window says it once: `schedule_time` opens, `schedule_until` closes (inclusive),
-- `schedule_every_minutes` steps. Both window columns null is the single-time shape, unchanged, so
-- nothing written before this behaves differently. How long the device then holds the state is the
-- action's `duration_seconds` (section 7) — this says WHEN, that says HOW LONG, and between them
-- the whole sentence is expressible with the device owning the part it should own.

ALTER TABLE "user_rule_conditions"
  ADD COLUMN "schedule_until" VARCHAR(5),
  ADD COLUMN "schedule_every_minutes" INTEGER;
ALTER TABLE "blueprint_rule_template_conditions"
  ADD COLUMN "schedule_until" VARCHAR(5),
  ADD COLUMN "schedule_every_minutes" INTEGER;

-- Pipeline triggers get the same shape, replacing `schedule_cron` — which was accepted at publish,
-- persisted, derived and reconciled, and then **never evaluated**: nothing in automation-worker ever
-- read it, so a pipeline with a schedule trigger never ran at all. Rather than write a cron
-- evaluator to match a column nobody could read back correctly, the two surfaces now share one
-- schedule shape and one matcher.
--
-- Best-effort carry-over for the only cron form that had an unambiguous single-time reading
-- ("M H * * *"); anything else becomes an unset schedule, which is honest — it was never running.

ALTER TABLE "pipeline_triggers"
  ADD COLUMN "schedule_time" VARCHAR(5),
  ADD COLUMN "schedule_until" VARCHAR(5),
  ADD COLUMN "schedule_every_minutes" INTEGER,
  ADD COLUMN "schedule_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
UPDATE "pipeline_triggers"
SET "schedule_time" = lpad(split_part("schedule_cron", ' ', 2), 2, '0') || ':' ||
                      lpad(split_part("schedule_cron", ' ', 1), 2, '0')
WHERE "schedule_cron" ~ '^[0-9]{1,2} [0-9]{1,2} \* \* \*$';
ALTER TABLE "pipeline_triggers" DROP COLUMN "schedule_cron";

ALTER TABLE "blueprint_pipeline_template_triggers"
  ADD COLUMN "schedule_time" VARCHAR(5),
  ADD COLUMN "schedule_until" VARCHAR(5),
  ADD COLUMN "schedule_every_minutes" INTEGER,
  ADD COLUMN "schedule_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
UPDATE "blueprint_pipeline_template_triggers"
SET "schedule_time" = lpad(split_part("schedule_cron", ' ', 2), 2, '0') || ':' ||
                      lpad(split_part("schedule_cron", ' ', 1), 2, '0')
WHERE "schedule_cron" ~ '^[0-9]{1,2} [0-9]{1,2} \* \* \*$';
ALTER TABLE "blueprint_pipeline_template_triggers" DROP COLUMN "schedule_cron";


-- ══ The clock a schedule is read against ─────────────────────────────────────

-- Section 8 gave schedules a window. This gives them a timezone, because a window made the missing
-- one impossible to ignore: a schedule was evaluated in the timezone of whichever process ran the
-- matcher, which in a container is UTC. A user in Israel who wrote "06:00" got a rule that fired at
-- 09:00 their time. A single daily firing hid that; "from 06:00 to 17:30" does not — it is a
-- sentence about daylight, and it was landing three hours late.
--
-- NULL keeps the old behaviour (evaluate in the server's zone) so nothing changes for a user who
-- has never signed in since. The client fills it from the browser on first sign-in, so "local" is
-- the default without anyone having to choose it.

ALTER TABLE "users" ADD COLUMN "timezone" VARCHAR(64);


-- ══ Every command sent to a device ───────────────────────────────────────────

-- The write side's twin of sensor_history (F11.12).
--
-- A command left no durable trace: the in-flight record lived in Valkey under a TTL, and the only
-- thing that outlived it was `current_state` — the LAST value, which says nothing about who set it,
-- when, or whether the device ever confirmed. "Why did the pump run at 3am" had no answer, and a
-- command that was never acked looked exactly like one that was never sent.
--
-- One row per dispatch, written at the single point every command passes through whoever raised it,
-- then settled in place by the ack. `status` starts at 'sent' rather than 'pending' because by the
-- time the row exists the command is already on its way to the broker; a row still 'sent' means no
-- ack was ever seen, which is a real outcome worth being able to see.

CREATE TABLE "device_commands" (
  "id"                    SERIAL PRIMARY KEY,
  "user_id"               INTEGER NOT NULL,
  "user_device_id"        INTEGER,
  "user_device_action_id" INTEGER,
  "action_name"           VARCHAR(64)  NOT NULL,
  "target_state"          VARCHAR(255) NOT NULL,
  "duration_seconds"      INTEGER,
  "source"                VARCHAR(20)  NOT NULL DEFAULT 'system',
  "source_ref_id"         INTEGER,
  "source_label"          VARCHAR(255),
  "status"                VARCHAR(20)  NOT NULL DEFAULT 'sent',
  "command_id"            VARCHAR(64),
  "result_value"          VARCHAR(255),
  "dispatched_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at"            TIMESTAMPTZ(6),
  CONSTRAINT "device_commands_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- SET NULL, not CASCADE: deleting a device must not erase the record of what it was told to do.
  CONSTRAINT "device_commands_user_device_id_fkey"
    FOREIGN KEY ("user_device_id") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "device_commands_user_device_action_id_fkey"
    FOREIGN KEY ("user_device_action_id") REFERENCES "user_device_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- The ack settles the row by this, so it has to be unique. Partial, because a dispatch raised
-- without one (a path that predates correlation) still deserves a history row.
CREATE UNIQUE INDEX "device_commands_command_id_key" ON "device_commands" ("command_id");

-- The two questions the history page asks: "what happened here" and "what happened to this".
CREATE INDEX "device_commands_user_id_dispatched_at_idx"
  ON "device_commands" ("user_id", "dispatched_at");
CREATE INDEX "device_commands_user_device_action_id_dispatched_at_idx"
  ON "device_commands" ("user_device_action_id", "dispatched_at");


-- ══ A phase duration that can differ per device ──────────────────────────────

-- Section 1 gave each bound device its own lifecycle. This lets two devices share ONE lifecycle and
-- still disagree about how long a phase lasts (F11.13).
--
-- The duration lived on the phase, and the phase belongs to the profile — so every device on a
-- profile shared it, and "basil roots in 3 days, lettuce in 5" could only be expressed by
-- duplicating a whole lifecycle to change one number. Making the column text lets it hold a
-- reference (`@param.seedling.days`) instead of a literal, which puts the answer inside the
-- resolution stack that already exists: a per-binding override of that param is how one pot gets a
-- shorter phase, set the same way as every other per-pot number.
--
-- Widening INTEGER → VARCHAR needs an explicit cast; every existing value is a literal and reads
-- back identically ("7" is still 7 to the resolver), so no data changes meaning.

ALTER TABLE "blueprint_phases"
  ALTER COLUMN "duration_value" TYPE VARCHAR(100) USING "duration_value"::text;


-- ══ The numbers beside the value, made referenceable too ─────────────────────

-- The section above let a PHASE's own length be a reference. This does the same for the values a
-- phase should own but could not reach (F11.14): how long the device holds a state, how long to
-- wait first, and what time of day a schedule fires.
--
-- `target_state` and `threshold_value` have always been text and have always accepted `@phase.x`,
-- which is what lets one rule serve several lifecycles. Everything beside them was an INTEGER or a
-- VARCHAR(5) clock read raw by the evaluators — so "water for 60s" and "water for 180s" were the
-- same rule with one number changed, and a blueprint covering three lifecycles carried three copies
-- of it plus three more for lights-off at 20:00 / 22:00 / 18:00. The number is a property of the
-- growth stage; it just had nowhere to live.
--
-- Same cast, same guarantee as above: every existing value is a literal and reads back identically,
-- so nothing already written changes meaning. `delay_seconds` additionally loses its NOT NULL
-- DEFAULT 0 — null and 0 both mean "publish now", and a nullable column is what lets a template
-- omit the field rather than assert a zero it did not choose.

ALTER TABLE "user_rule_actions"
  ALTER COLUMN "duration_seconds" TYPE VARCHAR(100) USING "duration_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP DEFAULT,
  ALTER COLUMN "delay_seconds" TYPE VARCHAR(100) USING "delay_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP NOT NULL;

ALTER TABLE "scene_members"
  ALTER COLUMN "duration_seconds" TYPE VARCHAR(100) USING "duration_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP DEFAULT,
  ALTER COLUMN "delay_seconds" TYPE VARCHAR(100) USING "delay_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP NOT NULL;

ALTER TABLE "blueprint_rule_template_actions"
  ALTER COLUMN "duration_seconds" TYPE VARCHAR(100) USING "duration_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP DEFAULT,
  ALTER COLUMN "delay_seconds" TYPE VARCHAR(100) USING "delay_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP NOT NULL;

ALTER TABLE "blueprint_scene_template_members"
  ALTER COLUMN "duration_seconds" TYPE VARCHAR(100) USING "duration_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP DEFAULT,
  ALTER COLUMN "delay_seconds" TYPE VARCHAR(100) USING "delay_seconds"::text,
  ALTER COLUMN "delay_seconds" DROP NOT NULL;

-- The clocks. VARCHAR(5) held exactly "HH:MM" and nothing longer — a reference could not physically
-- fit, which is why this had to widen rather than just being reinterpreted.

ALTER TABLE "user_rule_conditions"
  ALTER COLUMN "schedule_time" TYPE VARCHAR(100),
  ALTER COLUMN "schedule_until" TYPE VARCHAR(100);

ALTER TABLE "pipeline_triggers"
  ALTER COLUMN "schedule_time" TYPE VARCHAR(100),
  ALTER COLUMN "schedule_until" TYPE VARCHAR(100);

ALTER TABLE "blueprint_rule_template_conditions"
  ALTER COLUMN "schedule_time" TYPE VARCHAR(100),
  ALTER COLUMN "schedule_until" TYPE VARCHAR(100);

ALTER TABLE "blueprint_pipeline_template_triggers"
  ALTER COLUMN "schedule_time" TYPE VARCHAR(100),
  ALTER COLUMN "schedule_until" TYPE VARCHAR(100);
