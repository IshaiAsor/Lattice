-- Per-phase time bank (F10.12).
--
-- Every phase change re-stamped `phase_started_at`, so rolling a phase back restarted it from
-- zero — there was nowhere to record the time already spent there. This table is that place:
-- leaving a phase banks the elapsed seconds, and re-entering it can spend the bank ("resume"),
-- discard it ("reset") or replace it with a value the user names.
--
-- No backfill. An absent row means zero banked, which is exactly today's behavior, so every
-- existing instance keeps its current timing until someone deliberately resumes a phase.

CREATE TABLE "blueprint_instance_phase_state" (
    "id"              SERIAL       NOT NULL,
    "instance_id"     INTEGER      NOT NULL,
    "phase_key"       VARCHAR(64)  NOT NULL,
    "accrued_seconds" INTEGER      NOT NULL DEFAULT 0,
    "last_exited_at"  TIMESTAMP(6),
    "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprint_instance_phase_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blueprint_instance_phase_state_instance_id_phase_key_key"
    ON "blueprint_instance_phase_state" ("instance_id", "phase_key");

ALTER TABLE "blueprint_instance_phase_state"
    ADD CONSTRAINT "blueprint_instance_phase_state_instance_id_fkey"
    FOREIGN KEY ("instance_id") REFERENCES "blueprint_instances" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
