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
- never satisfies a threshold for a fault reading
- recognizes a fault envelope
- rejects normal scalar/object readings
- is not in cooldown when the trigger has never fired
- is not in cooldown when no interval is set
- is in cooldown while inside the interval window
- is out of cooldown once the interval has elapsed

### Telemetry — `telemetry.topic-parser.test.ts` ✅

- parses a telemetry topic
- parses an ack topic
- parses a status topic (no action name)
- joins multi-segment action names
- rejects topics with fewer than six segments
- rejects topics with empty required segments

### Blueprints — `blueprints.params-resolver.test.ts` ✅ (F10.1 `@lattice/params`)

- recognises a whole-value reference
- treats a literal as a literal
- rejects a reference with text around it as a whole-value reference
- parses kind and dotted key
- does not swallow a trailing full stop
- finds every reference embedded in free text
- resolves a phase reference to the current phase target
- lets a user override beat the phase target
- falls back to the blueprint default when the phase sets no target
- ignores the phase target for a @param reference
- lets a user override beat the default for a @param reference
- passes a literal through untouched
- resolves an unknown parameter to null so the caller fails closed
- resolves against an empty context to null, never to the raw reference
- resolves @phase.name and @phase.key to the current phase
- resolves absent context notes to an empty string, not null
- resolves phase metadata to null when the instance has no current phase
- does not let an override shadow phase metadata
- substitutes references inside a prompt template
- drops an unresolvable reference from the text and reports it
- leaves text with no references untouched
- accepts a reference to a declared parameter
- rejects a reference to an undeclared parameter and names it
- accepts phase metadata without it being a declared parameter
- validates every reference embedded in free text
- accepts a literal with no references
- rejects a parameter key that collides with phase metadata
- rejects a malformed parameter key
- accepts a dotted parameter key
- maps each layer onto the shape the resolver expects
- produces a context the resolver reads with the documented precedence
- yields no phase and no targets for an instance between phases
- normalises absent phase notes to null rather than undefined
- resolves every reference to null in the empty context, so a non-blueprint entity fails closed
- applies a phase-scoped override only while the instance is in that phase
- lets the more specific phase row beat the user’s all-phases row
- keeps a phase-scoped row out of @param., which addresses the blueprint value
- ignores a row scoped to a phase the instance is not in, including when it has none
- reports the layer it used, so the instance page cannot mislabel a value
- lets one device's own override beat the setup-wide one
- lets a device's phase-scoped override beat its own all-phases one
- keeps a device's phase-scoped override out of @param.
- resolves through all six layers in order, most specific first
- leaves a setup with no per-device context on exactly the four layers it always had
- resolves a field to the answer given for this device
- falls back to the setup answer when the device was not asked
- falls back to the field's default when neither was answered
- resolves an unanswered field to null so the caller fails closed
- rejects a reference to an undeclared field and names it
- accepts a reference to a declared field
- substitutes a field reference inside a prompt template

### Blueprints — `blueprints.phase-schedule.test.ts` ✅ (F10.4 phase auto-advance + F10.12 time bank + F11.x advance target)

- converts each supported unit to seconds
- returns null for an unknown unit rather than guessing one
- treats a missing, zero or negative value as no duration
- is due once the full duration has elapsed
- is due when the duration is overshot, so a downtime gap still advances
- is not due one second early
- is never due for a phase not on a schedule (its advance_mode is not "schedule")
- is never due for the last phase — a terminal phase is a resting state, not an error
- is never due when the phase was never entered
- is never due when the duration is missing or unparseable
- counts banked time, so a resumed phase fires early by exactly what it banked
- is due on the spot when the bank already covers the duration
- ignores a bank on a phase that never elapses, rather than inventing a deadline
- picks the next-highest ordinal, not ordinal + 1
- skips a gap left by a phase removed in a later blueprint version
- returns null from the last phase
- returns null when the current ordinal is past every declared phase
- is order-independent — it sorts rather than trusting the query order
- with no target key, advances to the next phase by ordinal
- with a target key, jumps to that phase wherever it sits
- allows an explicit rewind to an earlier phase
- is a no-op (null) from the last phase with no target
- is a no-op (null) when the target is the current phase — the idempotency guard
- is a no-op (null) when the target key names no phase in this profile
- floors to whole seconds
- never returns a negative, so a clock stepping back cannot credit unspent time
- adds the live run to the bank for the phase in flight
- is the bank alone for a phase not currently running
- treats a missing or negative bank as zero
- reset discards the bank — what the cron always does
- resume keeps the bank, which is what makes a rollback an undo
- at takes the requested value and ignores the bank
- floors a fractional request and refuses a negative one
- clamps to what the column can hold rather than overflowing it
- passes a literal through untouched
- resolves a reference to the blueprint default when nothing overrides it
- gives one device a shorter phase than its siblings on the same lifecycle
- fails closed when the reference resolves to nothing
- makes a phase with an unresolvable duration simply never due
- advances the pinned device first, on the same phase row
- reads a numeric string, which is how a resolved duration arrives
- treats an unresolved reference as no duration rather than throwing
  - the eight above are F11.13: a phase duration may be an `@param.` reference, so one lifecycle
    can hold devices whose phases run for different lengths — the case that previously forced a
    duplicate lifecycle to change one number

### Blueprints — `blueprints.positional-refs.test.ts` ✅ (F11.14 references beside the value)

- passes a literal through unchanged, so every pre-F11.14 row keeps its meaning
- resolves a literal with no context at all — a hand-written rule has none
- reads a phase reference through the full precedence, so an override wins
- reads a param reference, which ignores the phase target
- falls back to the default when neither an override nor a target sets it
- fails closed on a reference with no context, rather than treating it as a literal
- fails closed when the reference resolves to something that is not a number
- rejects a negative, which firmware would read as an enormous unsigned count
- floors a fractional value so every caller rounds the same way
- treats absent as absent — the caller supplies "indefinitely" or "now"
- accepts zero, which is a real delay meaning "publish now"
- passes a literal HH:MM through
- resolves a phase reference, so lights-off is a property of the stage
- normalises a missing leading zero, so 7:30 and 07:30 are the same time
- fails closed on anything that is not a time, so the schedule never fires
- fails closed on an unresolvable reference rather than firing at a default hour
- accepts a well-formed literal of either kind
- accepts any well-formed reference — whether the key exists is validateParamRefs’ job
- accepts absent, since both positions are optional
- rejects a unit-suffixed duration, the likeliest way to write one by hand
- rejects a negative duration
- rejects a clock that is not HH:MM
  - F11.14 extends what F11.13 did for a phase's own length to the values _beside_ `target_state`:
    how long the device holds a state, how long it waits first, and what time of day a schedule
    fires. Those were integers and a `VarChar(5)` clock, so "water for 60s" and "water for 180s"
    were the same rule duplicated per lifecycle. The two halves pinned here are that a literal
    still means exactly what it did, and that anything unresolvable yields null rather than a guess.

### Blueprints — `blueprints.phase-scope-gate.test.ts` ✅ (F10 phase scoping + F10.13 lifecycle gate)

- is active in any phase
- is active even with no current phase
- treats null/undefined scope like an empty one (defensive)
- is active when the current phase is in scope
- is inactive when the current phase is not in scope
- matches any one of several scoped phases
- is inactive when the instance has no current phase — it cannot be "in" an unset phase
- is running only in the running state
- treats "no instance" as live — a hand-written rule is not gated by blueprints at all
- refuses an unrecognised state rather than assuming it means running
- needs the setup running AND the phase in scope
- holds an unscoped automation too — stopping a setup stops all of it
  - the load-bearing case for F10.13: empty scope passes the phase gate, so only the lifecycle gate can hold it
- leaves hand-written automations untouched
- holds a scoped automation whose setup is stopped in one of its phases
- holds a per-device automation whose own device is not running
- runs a per-device automation when both its device and its setup are running
- holds every device’s automations when the setup is stopped, whatever the devices say
- ignores the device gate when no device is named — a setup-wide automation is unchanged
- collapses the two lifecycles into one effective state, setup first
- reports a device as not started even inside a running setup
- reports every device as stopped once the setup is stopped

### Blueprints — `blueprints.fanout.test.ts` ✅ (F11.2 per-device fan-out, F11.9 device selector)

- produces exactly one entity for a combined template
- produces one entity per bound device of the fan-out slot
- produces nothing when the fan-out slot has no bound device
- ignores the fan-out slot key when the mode is combined
- names each entity after the device's label
- falls back to the device's own name when the binding has no label
- leaves a combined entity's name untouched
- narrows only the named slot, leaving every other slot on all of its devices
- resolves the narrowed slot to that one device's action
- leaves an unscoped resolver resolving every device
- fans out per device over only the selected lifecycles
- covers only the selected devices in one combined entity
- leaves a selected combined entity's name untouched
- produces nothing when no bound device follows a selected lifecycle
- ignores an unprofiled device when a lifecycle is selected
- covers every device when the selection is empty
- keeps binding order when the selection is given out of order
- narrows a combined resolver to the selected devices only

### Pipelines — `pipelines.device-labels.test.ts` ✅ (F11.7 context labelling)

- keeps distinct labels exactly as they are
- disambiguates two devices that share a label
- leaves a single device alone even when it repeats across sensors
- disambiguates every member of a three-way collision
- handles an empty sensor list

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
- fires at the start of a window
- fires at each interval inside the window
- does not fire between intervals
- fires on the closing minute when it lands on the interval
- does not fire past the end of the window
- does not fire before the window opens
- ignores the window when the interval is zero
- ignores the interval when no end is given
- refuses a window that ends before it starts
- still honours the days list inside a window
- rejects a malformed time
- fires at the local time of the given zone
- does not fire at that wall time in another zone
- reads UTC when the zone is UTC
- takes the day of week from the zone, not from UTC
- applies the zone to a window as well as a single time
- falls back to the server zone for an unknown name rather than never firing
- handles midnight without reporting hour 24
  - the seven above pin the owner's-clock evaluation: a schedule is a sentence about the user's
    day, and before this it was read in the evaluating process's zone (UTC in a container)
- accepts a single time
- accepts a full window
- rejects a missing or malformed time
- rejects half a window, in both directions
- rejects a window that ends before it starts
- rejects an interval longer than the window
- rejects an out-of-range day
  - one validator behind the rules API, the pipelines API and blueprint publish
- is false when it has never fired
- is true earlier in the same minute
- is false in the previous minute, even 10 seconds ago
  - the minute guard: the scans tick every 10s, so a matching minute would otherwise fire six times
- reads a single time
- reads a window
- says so when there is no schedule

### Provisioning — `provisioning.action-compatibility.test.ts` ✅

- accepts identical implementation type and pin slots
- rejects a changed implementation type
- rejects a changed pin count
- rejects a renamed pin slot and names it in the reason
- accepts zero-pin capabilities
- accepts the same pin slots in a different order
- names every pin slot that disappeared when several do
- keeps capabilities that share an mqtt_action_name
- resolves an action to its own capability, not a same-named sibling
- reports a genuinely removed capability as absent
- remaps configured pins to the new capability pin ids by key
- drops pins whose key no longer exists in the new capability
- drops pins referencing unknown old catalog ids
- handles empty inputs

### Commands — `commands.command-models.test.js` ✅

- OutletCommandAction accepts on/off/1/0 and rejects others
- LightDimmerAction accepts on/off and 0..100, rejects out-of-range / non-numeric
- OneDirectionalMotorAction behaves like the dimmer range
- PwmOutputAction behaves like the dimmer range
- I2cSocket8Action / I2cSocket16Action behave like the outlet (on/off/1/0)
- unknown implementation types are accepted optimistically
  - mirrors firmware `BaseCommandAction::validateActionPayload` (parity rule)

### Platform — `platform.queue-contracts.test.ts` ✅ (the contract tier)

- every routing key has a schema
- every schema is covered by a contract case
- accepts the canonical payload
- rejects the broken payload
  - the two above run per routing key via `describe.each` — 18 RKs × (canonical accept + representative mutation reject)
- throws on an off-contract payload
- passes a canonical payload through to the channel
- skips validation for unknown (dynamic ML-stage) routing keys

### Platform — `platform.notifications.test.ts` ✅ (F15 notification catalog + templates)

- in-app defaults on for every event (it is the inbox)
- email defaults on only for emergency + transactional events
- push and sms default off everywhere
- in-app emergency is locked; nothing else is
- transactional events are excluded from the user-configurable set
- validates channel names
- renders each known event with its data
- falls back gracefully for an unknown event type
- tolerates missing data fields without throwing
- leaves production notifications untagged
- prefixes the title and footers the body outside production
- treats a missing or blank environment as unknown, not production

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

### Notifications — `notifications.e2e.test.ts` ✅ (F15)

- preferences round-trip: flip a configurable cell and it persists
- register creates an unverified account and login is gated (F15.8)
- notification.send is delivered to the in-app inbox
- delete: single soft-delete then clear-all empties the inbox
- push subscription: register, upsert, validate, unsubscribe
- push public key endpoint returns a shape the browser can consume

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

### Telemetry — `telemetry.camera.e2e.test.ts` ✅

- ⬜ camera frame → sensor_history row + socket frame event; current_state untouched
- take_picture with commandId → on-demand frame resolves the pending capture
  - now raised by `POST /api/actions/:id/capture` (a user asking from the camera card); the frame
    comes back tagged with that commandId and lands in history
- ⬜ pending capture with no frame → timeout path publishes PICTURE_RESULT status timeout
  - the durable half (a `device_commands` row settling `timeout`) is unassertable from e2e until
    the command-history read API exists — F18.7

### Telemetry — `telemetry-fault.e2e.test.ts` ✅

- a fault reading is recorded but leaves current_state on the last good value
  - fault envelope `{"error":"read_failed",...}` → sensor_history row (is_error), current_state unchanged, no pipeline run

### MQTT lifecycle — `heartbeat.e2e.test.ts` ✅

- publishes a heartbeat with the expected diagnostics shape
  - device heartbeat → RK.DEVICE_HEARTBEAT → digest writes the Valkey last-seen key

### Commands — `command-read.e2e.test.ts` ✅

- read reports current state, and still does after a restart
  - reserved `read` verb answers from NVS-persisted state; survives a device restart

### Commands — `ota-command.e2e.test.ts` ✅

- an ota command on the device topic updates that device, and its ack is not DLQd
  - per-device `ota` verb (F3.15 step 1) reaches one device; the `starting:` ack is processed by
    digest rather than dead-lettered as an unresolvable action
- an ota command for a version already running is rejected, not applied
  - strictly-newer gate answers `rejected:not-newer`, and the device keeps its version

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

### Blueprints — `blueprints.e2e.test.ts` ✅ (F10.2–F10.4, F10.12–F10.13, F11)

- refuses to publish a blueprint whose action is not on the slot template
- imports and publishes a valid blueprint
- offers each slot the devices its sealed template covers
- refuses a binding whose device does not match the slot
- derives an instance with an area, bindings and every templated entity
- stores references verbatim in every derived entity, not resolved values
  - rule condition/action **and** scene member; a literal member stays literal, so execution has to handle both shapes
- runs a derived scene, resolving a @param member into a real device command
  - asserted at the board and at the ack — `POST /scenes/:id/execute` returns 202 before anything is dispatched
- fires a pipeline whose trigger threshold is a phase reference
- does not fire that pipeline for a reading above the resolved threshold
  - the other direction: a resolver returning something falsy would make every comparison pass
- resolves a param through phase → default → override, in that order
  - and asserts the rule row is byte-identical across all three — the central invariant
- refuses to override a param the blueprint marked phase-driven
- starts the setup, entering the phase the user names
  - deriving builds a setup; starting it is a separate act, because when the real process began is something only the user knows
- banks the time spent in a phase when the setup leaves it
- resumes a phase from its bank rather than restarting it
  - the rollback case F10.12 exists for: leaving banks, re-entering can spend the bank instead of restarting from zero
- starts a phase at a point the caller names
- resets a phase to zero, discarding what it had banked
- rejects a malformed timer request rather than guessing at it
  - unknown `timer`, `at` without `elapsed_seconds`, and resuming the phase already running
- holds a scene while the setup is stopped, and releases it on start
  - the scene is **unscoped**, so the phase gate alone would never hold it — this is the lifecycle gate or nothing
- banks the run when stopped, and carries on from it when started again
- lists a setup with the lifecycle needed to read it without opening it
  - the setups list carries state + current phase + that phase's timer, so the landing page can answer "is this doing anything?"
- refuses a phase change while the setup is not running
- resets to never-started, discarding the banks but keeping the setup
- rejects a malformed or contradictory lifecycle request
- leaves every automation row untouched by a timer change
- marks a derived rule the user edits as drift
- publishes a v2 into the live setup, keeping the user edit and updating the rest
- restores an edited rule from the blueprint on reset
- derives a static blueprint already running, and pauses/resumes it
- refuses to publish a static blueprint that still declares phases
- refuses to publish a blueprint with no phases that is not marked static
  - not every blueprint is time-dependent; pausing still holds its automations, and resuming must work with no phase to enter
- offers both boards as candidates for a multi-device slot
- fans a scene member and a rule action out to every bound board
  - a `max_count > 1` slot binds several devices; each template leaf that names it expands to one derived row per bound device
- still rejects a device that does not match the multi slot
- refuses to publish an automation scoped to an undeclared phase
- derives a scoped rule and scene, preserving their phase_scope
- refuses to run a scene out of its phase, then allows it after advancing
- refuses to publish a combined template that reads @phase over a profiled slot
- derives a setup whose devices follow the lifecycle their answer chose
- refuses a device on a profiled slot with no way to know its lifecycle
- materialises one rule per bound device, each wired to only that device
- materialises a per-device rule on only the selected lifecycle
- materialises one combined scene covering only the selected devices
- re-enables an automation it disabled once its device returns to the selection
- leaves an automation the user disabled switched off across a reconcile
- refuses to publish more than one lifecycle when no slot chooses between them
- refuses to publish a selector naming an undeclared lifecycle
- refuses to publish a selector over a slot whose devices share the setup
- refuses to publish a selector over a slot the template never addresses
- starts one device without touching the other
- advances one device, leaving the other where it was
- refuses a phase that belongs to the other device lifecycle
- holds every device once the setup is stopped
- summarises the devices on the setups list rather than a phase it does not have
- carries a whole track per device on the setups list (F11.4)
- puts a device on another lifecycle when it is reset
- refuses a lifecycle action on a device the setup shares
  - phase scope is read at evaluation time; advancing a phase is one column write and touches no scene/rule rows
- ⬜ derived rule fires end-to-end against sim telemetry at the phase's threshold
- ⬜ auto-advance cron rolls an elapsed phase over

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
