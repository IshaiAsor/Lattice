-- Explicit setup lifecycle (F10.13).
--
-- Deriving a setup used to start it: the wizard's last click set the first phase and stamped the
-- clock. But creating the setup in the app and the real-world process beginning are different
-- events — connecting a device says nothing about when the thing it watches started — so starting
-- becomes a decision the user makes, with a phase and a position inside it.
--
-- Three states: not_started (no phase, no clock), running, stopped (phase remembered, clock
-- parked). Nothing a setup derived acts while it is not running.
--
-- Backfill is deliberately asymmetric with the new default:
--   * the column defaults to 'not_started', which is what every NEW derive wants;
--   * every EXISTING row is set to 'running', because those setups are live right now and a
--     migration must not silently stop a user's automations.
-- A row with no current phase never had a lifecycle to run (a blueprint with no phases), so it
-- stays running too — the alternative would leave it permanently inert.

ALTER TABLE "blueprint_instances"
    ADD COLUMN "lifecycle_state" VARCHAR(20) NOT NULL DEFAULT 'not_started';

UPDATE "blueprint_instances" SET "lifecycle_state" = 'running';
