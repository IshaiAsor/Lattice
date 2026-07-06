# Test Plan — full case inventory (source of truth)

The per-case companion to [TESTING.md](TESTING.md) (which holds the rules: tiers, naming,
staging safety model). **This list derives the implementation, not the other way around:**

- For every file marked ✅, each top-level bullet is the **exact test title** in that file.
- `tests/unit/platform.test-plan-sync.test.ts` parses this document and **fails the build
  when plan and code drift** in either direction (unimplemented plan case / unplanned test).
- Workflow: add or change a case **here first**, then implement it. New tests that aren't
  in the plan fail the sync check.
- Bullets starting with ⬜ are planned-but-not-yet-implemented cases (not enforced yet).
  Indented sub-lines are commentary, ignored by the sync check. Files marked ⬜/⏸ are
  entirely planned/deferred.

Legend: ✅ implemented (sync-enforced) · ⬜ planned · ⏸ deferred.

---

## 1. Unit tests — `tests/unit/` (pure logic, no stack, always run)

### Auth — `auth.jwt.test.ts` ✅

- accepts a token with the expected purpose
- rejects a "%s" token verified as "%s"
  - generated cross-purpose matrix: 8 purposes × 7 others = 56 cases (refresh-as-access, device-token-as-app-token, …)
- rejects an expired token
- rejects a token signed with a different secret
- rejects a tampered token
- rejects garbage input
- generates and verifies a token for a configured purpose
- throws when generating for a purpose with no configured expiry

### Telemetry — `telemetry.threshold.test.ts` ✅

- %s %s %s → %s
  - operator matrix: `>` `<` `>=` `<=` `=` `==` over 11 value/threshold combinations
- parses numeric strings
- falls back to string equality when either side is not numeric
- returns false for unknown operators on numeric input

### Telemetry — `telemetry.topic-parser.test.ts` ✅

- parses a telemetry topic
- parses an ack topic
- parses a status topic (no action name)
- joins multi-segment action names
- rejects topics with fewer than six segments
- rejects topics with empty required segments

### Automation — `automation.rules-logic.test.ts` ✅

- %s %s %s → %s
  - compare matrix: `>` `<` `>=` `<=` `=` `!=` (10 cases)
- returns false for unknown operators
- is expired when the rule never fired
- is not expired inside the cooldown window
- is expired exactly at the cooldown boundary
- is expired after the window
- zero cooldown always allows refiring
- matches on exact HH:MM with empty days (every day)
- does not match a different minute
- matches when today is in the days list
- does not match when today is not in the days list
- null time never matches
- pads single-digit hours/minutes (09:05)

### Provisioning — `provisioning.action-compatibility.test.ts` ✅

- accepts identical implementation type and pin slots
- rejects a changed implementation type
- rejects a changed pin count
- rejects a renamed pin slot and names it in the reason
- accepts zero-pin capabilities
- remaps configured pins to the new capability pin ids by key
- drops pins whose key no longer exists in the new capability
- drops pins referencing unknown old catalog ids
- handles empty inputs

### Commands — `commands.command-models.test.js` ✅

- OutletCommandAction accepts on/off/1/0 and rejects others
- LightDimmerAction accepts on/off and 0..100, rejects out-of-range / non-numeric
- OneDirectionalMotorAction behaves like the dimmer range
- unknown implementation types are accepted optimistically
  - mirrors firmware `BaseCommandAction::validateActionPayload` (parity rule)

### Platform — `platform.queue-contracts.test.ts` ✅ (the contract tier)

- every routing key has a schema
- every schema is covered by a contract case
- accepts the canonical payload
- rejects the broken payload
  - the two above run per routing key via `describe.each` — 17 RKs × (canonical accept + representative mutation reject)
- throws on an off-contract payload
- passes a canonical payload through to the channel
- skips validation for unknown (dynamic ML-stage) routing keys

### Platform — `platform.fleet-config.test.js` ✅

- drops undefined-valued keys, keeps everything else
- rejects a missing/empty devices array
- rejects a device group missing "type"
- rejects a non-positive count
- rejects defaults.mac
- defaults to count 1 and auto-generates a MAC
- numbers auto-generated MACs/labels across multiple groups of the same type (no collision)
- explicit mac on a count:1 group is used literally
- explicit mac on a count>1 group is used as a prefix
- rejects duplicate MACs across groups
- passes "capabilities" through as a per-group override
- rejects a non-array/non-string "capabilities"
- merges opts: baseOpts < config.defaults < group overrides, deviceType/mac always win
- undefined-valued keys in baseOpts do not clobber config values (compact applied)
- passes for unique macs, throws for duplicates

### Platform — `platform.test-plan-sync.test.ts` ✅ (the enforcement of this document)

- every ✅ plan file exists on disk
- every test file on disk is listed in the plan as implemented
- every implemented plan case exists as a test in its file
- no test exists that is not in the plan

### Google Home — `googlehome.token-guards.test.ts` ⬜

- client-secret check is timing-safe and rejects wrong length and wrong value
- redirect_uri mismatch invalidates the auth code (code deleted, invalid_grant)
- unsupported grant_type → 400
- refresh grant with a valid refresh token issues a new pair
- refresh grant with a wrong-purpose token → invalid_grant

---

## 2. Integration tests — `tests/integration/` (one service + real infra, skip when down)

### Platform — `platform.queue.integration.test.ts` ✅

- connect() asserted the static topology (DLQ queue exists)
- publish → consume round-trip preserves the payload
- a consumer that throws sends the message to the DLQ, not back to the queue

### Telemetry — `telemetry.digest.integration.test.ts` ⬜

- scalar telemetry → current_state updated + sensor_history row written
- image telemetry → sensor_history row + Valkey camera_frame key with TTL; current_state untouched
- unresolved device/action → consumer throws (DLQ contract), nothing written
- image with commandId resolves the pending picture request → PICTURE_RESULT published

### Provisioning — `provisioning.action-migration.integration.test.ts` ⬜

- previewUpdate returns up_to_date when the device is on the latest catalog version
- preview flags removed capabilities and renamed-pin capabilities as deprecated with reasons
- applyUpdate creates staged_active actions with migrated pins, stages incompatible ones as staged_deprecated, writes pending version fields
- re-apply clears previous in-flight staging before staging anew

### ML pipeline — `mlpipeline.ml-router.integration.test.ts` ⬜

- trigger → enrich stage → command_exec stage → done, with a stubbed executor answering the stage queues
- stage failure → pipeline run marked failed with error
- cancel mid-run stops subsequent stages

---

## 3. E2E tests — `tests/e2e/` (SimDevice through the full stack; staging = acceptance as e2e-bot)

### Cross-domain core — `device-sim.e2e.test.ts` ✅

- provisions and comes online
- telemetry updates the action current state
- valid command → ok ack (echoes commandId) and state update
- invalid command → error ack (no state change)
- duration command auto-offs with an unsolicited ack

### Auth — `auth.e2e.test.ts` ✅

- login returns an access + refresh token pair
- refresh-token rotation returns a new working pair
- a refresh token is rejected as an access token (purpose boundary)
- a wrong-purpose token signed with the real secret is rejected
  - local-only: needs JWT_SECRET from .env.test; self-skips on staging
- garbage and missing tokens are rejected

### Provisioning — `provisioning.e2e.test.ts` ✅

- provision creates the device and it reports online
- activation created actions for the catalog capabilities
- re-provisioning the same MAC keeps a single device identity (upsert)
  - encodes the upsert-by-MAC contract — red = the gap is real, not test noise
- deleting the device removes it from the list
- ⬜ OTA: preview lists ok/deprecated actions for a newer catalog version
- ⬜ OTA: apply stages staged_active/staged_deprecated + pending version fields
- ⬜ OTA: simulated device OTA ack swaps staged actions live
- ⬜ OTA: device rejects a not-newer version (error ack rejected:not-newer)

### Telemetry — `telemetry.camera.e2e.test.ts` ⬜

- camera frame → sensor_history row + socket frame event; current_state untouched
- take_picture with commandId → on-demand frame resolves the pending capture
- pending capture with no frame → timeout path publishes PICTURE_RESULT status timeout

### Commands — `commands.socket.e2e.test.ts` ✅

- rejects a connection without a token
- action_state_update reaches the device and the state echo returns

### Automation — `automation.e2e.test.ts` ✅

- threshold rule fires a command when telemetry crosses it
  - full chain: telemetry → digest → rules.evaluate → automation-worker → action.dispatch → device
- below-threshold telemetry does not fire the rule
- rule CRUD: list shows it, toggle disables it, delete removes it
- ⬜ schedule rule fires at the configured minute
- ⬜ cooldown suppresses an immediate refire
- ⬜ pipeline sensor-threshold trigger → pipelineRun row queued, cooldown respected

### ML pipeline — `mlpipeline.e2e.test.ts` ⬜

- pipeline trigger → run row transitions queued → completed (stub model)
- chat request via socket → token stream + DONE (requires cluster tunnel; skips otherwise)

### Google Home — ⏸ full account-link flow (needs a disposable Google test account)

---

## 4. Disruptive tests — `tests/e2e/*.local.test.ts` (local test stack only, TEST_DISRUPTIVE=1)

### Platform — `platform.resilience.local.test.ts` ✅

- a malformed message is dead-lettered, and the consumer survives
  - regression guard for the silent-offline incident
- consumers reconnect after a broker restart

---

## 5. Sanity tests — `tests/sanity/` (read-only, < 2 min, safe on any env incl. prod)

### Auth — `auth.sanity.test.ts` ✅

- login round-trip returns a token that works on a protected route
- bad credentials are rejected
- protected route without a token is rejected

### Devices — `devices.sanity.test.ts` ✅

- device list and action list respond with well-formed data
- capability catalog is seeded
  - empty catalog = provisioning broken

### Platform — `platform.sanity.test.ts` ✅

- core /health endpoints respond ok
  - api + gateway + SANITY_HEALTH_URLS extras
- every static queue has a live consumer (RabbitMQ mgmt API)
  - the silent-offline detector
- MQTT broker accepts an app-credential connection
- ⬜ Socket.IO handshake with an app token succeeds

---

## 6. Angular unit tests — `backoffice/src/**/*.spec.ts` (vitest after the Karma migration) ⬜

- auth.interceptor.spec.ts — attaches bearer token; skips public routes; 401 triggers refresh/redirect
- auth.guard.spec.ts — blocks unauthenticated navigation, allows authenticated
- socket.service.spec.ts — connects with token, fans events out to subscribers, reconnect behavior
- device-state.service.spec.ts — action_state_update/device_status_change events update store state
- pipes specs — display/formatting pipes with edge inputs
  - component DOM specs deliberately not required (TESTING.md tier rules)

---

## 7. UI e2e — `tests-ui/` (Playwright, local stack; login flow doubles as staging UI sanity) ⬜

- auth.spec.ts — login → lands on dashboard; bad password shows error
- dashboard.spec.ts — devices and states render
- device-control.spec.ts — toggle a SimDevice outlet from the UI → state round-trips
- provisioning.spec.ts — provisioning wizard smoke
- chat.spec.ts — send a message, receive a streamed reply

---

## 8. CI-only checks ⬜

- migration-check (in checks.yml): empty Postgres service container → prisma migrate deploy → seed. Red while the 5 drifted tables lack migrations — intentionally.
- acceptance.yml: workflow_dispatch + weekly schedule → test:sanity + test:acceptance with TEST_TARGET=staging from GH environment secrets.
- Kargo verification (oci-k3s-gitops): in-cluster Job runs test:sanity after each staging promotion; Freight unverified until green.
