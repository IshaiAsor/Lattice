-- F18.19 — retention activity log.
--
-- `retention_runs` records what a SWEEP did. Nothing recorded the configuration half: a tier row
-- carries `updated_at`, which is current state, not history — it can say a list changed this
-- morning, never who changed it or from what. For a feature whose whole purpose is deleting data
-- irreversibly, that is the wrong side of the line.
--
-- Append-only. Nothing here is ever updated or deleted, which is what keeps it separate from
-- `retention_runs` (live `phase`/`lock_key`); the two are linked by `run_id`.
--
-- Additive only: one new table, no change to any existing one.

CREATE TABLE "retention_activity" (
    "id"              SERIAL       NOT NULL,
    "at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action"          VARCHAR(24)  NOT NULL,
    "scope"           VARCHAR(12)  NOT NULL,
    "actor_kind"      VARCHAR(8)   NOT NULL,
    "actor_user_id"   INTEGER,
    -- Denormalized on purpose: the FK below is SetNull, so deleting a user must neither be blocked
    -- by an audit row nor erase who acted. The id goes; the name stays.
    "actor_name"      VARCHAR(120),
    "subject_user_id" INTEGER,
    "subject_ref_id"  INTEGER,
    -- The device / action / blueprint name AT THE TIME, so the entry still reads correctly after a
    -- rename or a delete.
    "subject_label"   VARCHAR(160),
    "data_kind"       VARCHAR(20),
    "summary"         VARCHAR(400) NOT NULL,
    "before"          JSONB,
    "after"           JSONB,
    "run_id"          INTEGER,

    CONSTRAINT "retention_activity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retention_activity_at_idx" ON "retention_activity"("at");
CREATE INDEX "retention_activity_subject_user_id_at_idx" ON "retention_activity"("subject_user_id", "at");
CREATE INDEX "retention_activity_action_at_idx" ON "retention_activity"("action", "at");
CREATE INDEX "retention_activity_run_id_idx" ON "retention_activity"("run_id");

ALTER TABLE "retention_activity" ADD CONSTRAINT "retention_activity_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "retention_activity" ADD CONSTRAINT "retention_activity_subject_user_id_fkey"
    FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "retention_activity" ADD CONSTRAINT "retention_activity_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "retention_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
