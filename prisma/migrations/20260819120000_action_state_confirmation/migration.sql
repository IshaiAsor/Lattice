-- How fresh an action's current_state is, and where that freshness came from.
--
-- current_state for a COMMAND action was never an observation — it is a cache of the last ack
-- the platform happened to see. Telemetry actions self-correct, because the next cyclic reading
-- overwrites whatever the DB believed; command actions have no such loop, so a single lost ack
-- (broker drop, digest down, a device restoring NVS state while the consumer was gone, a timed
-- hold releasing itself) left the row wrong indefinitely with nothing able to notice. The value
-- is not display-only: the rules engine gates conditions on it, ml-router puts it in the LLM
-- prompt, and google-home reports it to Google QUERY.
--
-- What was unrepresentable before is the confidence itself. updated_at is not a substitute: it
-- also moves on writes that are not confirmations, and it carries no source, so "we last heard
-- this two minutes ago from the device" and "we wrote this ourselves an hour ago" were the same
-- row. These two columns separate them, which is what lets a reconcile sweep pick stale actions
-- and what lets the UI show confidence instead of hiding it.
--
-- Written by every path that confirms state, not only reconcile: digest's telemetry consumer
-- ("telemetry"), its ack consumer ("command-ack", or "boot-restore" for an unsolicited ack with
-- no commandId), and the reconcile read-back ("reconcile").
--
-- Nullable with no backfill: NULL means "never confirmed", which is the honest reading of every
-- row that exists today — the platform genuinely does not know when they were last true. The
-- reconcile sweep orders NULLs first, so pre-existing rows are simply the first to be checked.

ALTER TABLE "user_device_actions" ADD COLUMN "last_confirmed_at" TIMESTAMPTZ(6);
ALTER TABLE "user_device_actions" ADD COLUMN "state_source" VARCHAR(20);
