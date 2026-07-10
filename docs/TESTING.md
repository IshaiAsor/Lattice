# Testing — strategy, tiers, and the domain catalog

This document is a **guardrail**: new code follows the tier rules below, and new features
add tests where the catalog says their domain is covered. Decisions here were made
deliberately (2026-07-05) — change them by editing this doc, not by drifting.
The per-case inventory (every individual test, implemented and planned) lives in
[TEST-PLAN.md](TEST-PLAN.md).

All Jest suites live at the repo root under `tests/` (root `jest.config.js`, ts-jest,
30s timeout). Services and packages do not have their own Jest setups. The backoffice has
its own runner (vitest via `ng test`); UI e2e (Playwright) lives in `tests-ui/`.

```bash
npm test                # everything Jest (e2e/sanity self-skip when the stack is down)
npm run test:unit       # unit only — fast, no stack
npm run test:sanity     # read-only sanity suite (local by default)
npm run test:e2e        # e2e only (local stack)
npm run test:acceptance # sanity + e2e against staging (TEST_TARGET=staging, needs STAGING_* env)
npm run test:e2e:up     # start ephemeral test stack (compose.test.yaml + .env.test) + migrate
npm run test:e2e:down   # tear it down (-v)
```

## Tiers

| Tier         | Location / naming                      | Scope                                                                  | Runs where                                              | Required when                                                                                                                              |
| ------------ | -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit         | `tests/unit/**/*.test.ts`              | Pure logic, no I/O                                                     | Always (CI, cold checkout)                              | New pure logic (parsers, validators, mappers, evaluators)                                                                                  |
| Contract     | `tests/unit/queue-contracts.test.ts`   | zod schema per `RK` payload                                            | Always                                                  | Any change to `packages/queue/src/types.ts`                                                                                                |
| Integration  | `tests/integration/**/*.test.ts`       | One service's logic + real infra (DB/Rabbit/Valkey), no other services | Local test stack                                        | Complex consumer/DB logic (digest-service, ml-router, action-migration only — do **not** add integration suites for thin adapter services) |
| E2E          | `tests/e2e/**/*.e2e.test.ts`           | SimDevice through the whole stack                                      | Local test stack; staging as **acceptance**             | New event flow, routing key, or device interaction                                                                                         |
| Disruptive   | `tests/e2e/**/*.local.test.ts`         | Kills/restarts infra (resilience, DLQ)                                 | Local test stack ONLY, opt-in via `TEST_DISRUPTIVE=1`   | New failure-handling behavior                                                                                                              |
| Sanity       | `tests/sanity/**/*.sanity.test.ts`     | Read-only happy path per domain, < 2 min total                         | Any env: local, staging (Kargo verification), even prod | New domain/service                                                                                                                         |
| Angular unit | `backoffice/src/**/*.spec.ts` (vitest) | Services, state, pipes, interceptors — **not** component DOM           | Always                                                  | New UI logic (services/stores); component DOM specs are not required                                                                       |
| UI e2e       | `tests-ui/` (Playwright)               | 5–8 critical browser flows                                             | Local stack; login flow doubles as staging UI sanity    | Only for the listed critical flows — keep this suite small                                                                                 |

### Environment targeting

`TEST_TARGET=local` (default) or `TEST_TARGET=staging`. The harness
(`tests/e2e/helpers/stack.ts`) resolves URLs and credentials:

- **local** — `.env.test` preferred over `.env` (current behavior), `admin/admin` fallback.
- **staging** — everything from env vars, never from files: `STAGING_API_URL`,
  `STAGING_GATEWAY_URL`, `STAGING_MQTT_URL` (`mqtts://…`), `E2E_BOT_USER`, `E2E_BOT_PASS`.
  Missing vars = hard error, not a fallback to local.

### The staging safety model (hard rules)

- **Sanity is read-only.** No suite under `tests/sanity/` may create, mutate, or delete
  anything. It is safe to point at any environment including prod.
- **Acceptance is mutating and runs only as the `e2e-bot` user.** Never real user data.
  Every acceptance suite cleans up what it creates (`SimDevice.cleanup()` deletes the
  device); MACs are prefixed `SIM-E2E-` so leaked residue is identifiable and sweepable.
- **Disruptive suites never run against staging.** They restart brokers and inject poison
  messages. The harness's `itDisruptive()` refuses to run unless `TEST_TARGET=local` AND
  `TEST_DISRUPTIVE=1`.

### Staging triggers (decided)

- **Kargo verification** (`oci-k3s-gitops/kargo/stages.yaml`): after each auto-promotion to
  staging, an in-cluster Job runs `test:sanity` against service DNS. Freight isn't verified
  (→ not prod-promotable) until sanity passes.
- **GitHub workflow `acceptance.yml`**: `workflow_dispatch` + weekly schedule, runs
  `test:acceptance` against staging from outside the cluster (GH environment secrets).

## Event contracts (zod)

Every `RK` payload has a zod schema in `packages/queue/src/schemas.ts`, mirroring the
interfaces in `src/types.ts`. `publish()` validates against the schema whenever
`NODE_ENV !== 'production'` and throws on mismatch — an off-contract publish fails in
dev/test instead of corrupting a downstream consumer. **Changing a payload interface
without updating its schema (and the contract test) is a broken change.**

---

## Test catalog by domain

Status: ✅ exists (file named) · ⬜ planned (next rounds) · ⏸ deferred (see bottom).
Test files are named `<domain>.<subject>.<tier-suffix>` — one file per domain per tier.

### Auth & users

| Tier   | Test                                                                     | Status                   |
| ------ | ------------------------------------------------------------------------ | ------------------------ |
| Unit   | `@lattice/jwt` full cross-purpose matrix, expiry, tamper, wrong secret   | ✅ `auth.jwt.test.ts`    |
| E2E    | login pair, refresh rotation, refresh-as-access rejected, forged purpose | ✅ `auth.e2e.test.ts`    |
| Sanity | login round-trip works; bad creds and missing token rejected             | ✅ `auth.sanity.test.ts` |

### Provisioning & device lifecycle (incl. OTA + action migration)

| Tier        | Test                                                                                                                    | Status                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Unit        | `isCompatible` (impl type / pin count / pin rename) + pin id→key→id migration mapping                                   | ✅ `provisioning.action-compatibility.test.ts` |
| E2E         | provision → online, actions created, re-provision same MAC keeps identity (upsert contract), delete removes             | ✅ `provisioning.e2e.test.ts`                  |
| E2E         | OTA: preview shows deprecated/ok actions; apply stages `staged_active`/`staged_deprecated`; sim OTA ack swaps them live | ⬜                                             |
| Integration | `action-migration.service` preview/apply against DB: staged-state transitions, pending version fields                   | ⬜                                             |
| Sanity      | device list + action list well-formed; capability catalog seeded                                                        | ✅ `devices.sanity.test.ts`                    |

### Telemetry → state

| Tier        | Test                                                                                                                     | Status                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Unit        | threshold evaluation operator matrix + NaN/string fallback                                                               | ✅ `telemetry.threshold.test.ts`    |
| Unit        | MQTT topic parsing (users/…/devices/… scheme, multi-segment actions, malformed topics)                                   | ✅ `telemetry.topic-parser.test.ts` |
| E2E         | scalar telemetry → `current_state` visible via API                                                                       | ✅ `device-sim.e2e.test.ts`         |
| E2E         | camera frame → sensor_history row + socket frame event, `current_state` untouched                                        | ⬜                                  |
| Integration | digest telemetry consumer: scalar → state write; image → history + Valkey key; unresolved action → throws (DLQ contract) | ⬜                                  |

### Commands & acks

| Tier | Test                                                                        | Status                               |
| ---- | --------------------------------------------------------------------------- | ------------------------------------ |
| Unit | command payload validation mirror (`command-models`)                        | ✅ `commands.command-models.test.js` |
| E2E  | valid command → ok ack → state; invalid → error ack; duration auto-off      | ✅ `device-sim.e2e.test.ts`          |
| E2E  | socket `action_state_update` → device command + state echo; no-token reject | ✅ `commands.socket.e2e.test.ts`     |

### Automation (rules + pipeline triggers)

| Tier   | Test                                                                                   | Status                              |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------- |
| Unit   | `compare` matrix, cooldown expiry (time-injected), `matchesScheduleAt` days/padding    | ✅ `automation.rules-logic.test.ts` |
| E2E    | threshold rule via API fires device command; below-threshold doesn't; CRUD list/toggle | ✅ `automation.e2e.test.ts`         |
| E2E    | pipeline sensor-threshold trigger → `pipelineRun` row queued, cooldown respected       | ⬜                                  |
| Sanity | automation-worker `/health` (via `SANITY_HEALTH_URLS`)                                 | ✅ `platform.sanity.test.ts`        |

### ML / chat pipeline

| Tier        | Test                                                                                                             | Status                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Integration | ml-router stage sequencing with stubbed executor (enrich → command_exec → done)                                  | ⬜                           |
| E2E         | chat request via socket → token stream + DONE (requires cluster tunnel or stub model — marked, may skip locally) | ⬜                           |
| E2E         | picture request → on-demand frame resolves pending capture (or timeout path)                                     | ⬜                           |
| Sanity      | ml-router + ml-executor `/health` (via `SANITY_HEALTH_URLS`)                                                     | ✅ `platform.sanity.test.ts` |

### Google Home

| Tier   | Test                                                                                         | Status                                   |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unit   | `/token` route guards: client secret timingSafeEqual, redirect_uri mismatch invalidates code | ⬜                                       |
| Sanity | google-home `/health` (via `SANITY_HEALTH_URLS`)                                             | ✅ `platform.sanity.test.ts`             |
| E2E    | full account-link flow                                                                       | ⏸ needs a Google test account — deferred |

### UI (backoffice)

| Tier         | Test                                         | Status |
| ------------ | -------------------------------------------- | ------ |
| Angular unit | auth interceptor/guard token handling        | ⬜     |
| Angular unit | socket service (connect/auth/event fan-out)  | ⬜     |
| Angular unit | device/action state stores + pipes           | ⬜     |
| UI e2e       | login → dashboard renders devices            | ⬜     |
| UI e2e       | device toggle round-trip (against SimDevice) | ⬜     |
| UI e2e       | provisioning wizard smoke; chat send/receive | ⬜     |

### Platform (queues, DLQ, migrations)

| Tier        | Test                                                                                                           | Status                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Contract    | every `RK` schema accepts canonical / rejects mutation; `publish()` throws on violation, skips dynamic ML keys | ✅ `platform.queue-contracts.test.ts`   |
| Unit        | device-sim fleet config                                                                                        | ✅ `platform.fleet-config.test.js`      |
| Integration | real broker: topology assert, publish/consume round-trip, throw→nack→DLQ with no redelivery                    | ✅ `platform.queue.integration.test.ts` |
| Disruptive  | poison message → `q.dlq`, consumer stays attached; broker restart → consumers reconnect                        | ✅ `platform.resilience.local.test.ts`  |
| CI          | fresh Postgres + `prisma migrate deploy` + seed (fails on schema/migration drift)                              | ⬜                                      |
| Sanity      | core `/health` endpoints; every static queue has ≥ 1 consumer (mgmt API, when reachable); MQTT connect         | ✅ `platform.sanity.test.ts`            |

### File map

```
tests/
  unit/           auth.jwt · telemetry.threshold · telemetry.topic-parser ·
                  automation.rules-logic · provisioning.action-compatibility ·
                  commands.command-models · platform.queue-contracts · platform.fleet-config
  integration/    platform.queue.integration
  e2e/            device-sim (cross-domain core) · auth · provisioning · automation ·
                  commands.socket · platform.resilience.local (disruptive)
  sanity/         auth · devices · platform
tests-ui/         (Playwright — planned)
backoffice/src/   *.spec.ts (vitest — migration planned)
```

## The skip-when-down convention (mandatory)

E2E/sanity cases use `itStack()` from the harness, never bare `it()`:

```ts
import { itStack, login } from '../e2e/helpers/stack';
itStack('device ack updates action state', async () => { ... });
```

`itStack` probes `/health` on api + device-gateway; if the stack is down it logs
`SKIP (stack down)` and passes. This keeps `npm test` green on a cold checkout and lets CI
run unit tests without infrastructure. Don't break this property. Disruptive cases use
`itDisruptive()` (same skip behavior + the safety gate above).

## Rules for new code

- **Plan first — the list derives the implementation.** Every test case is written in
  [TEST-PLAN.md](TEST-PLAN.md) before (or with) its implementation; the bullet text is the
  exact test title. `tests/unit/platform.test-plan-sync.test.ts` fails the build on drift
  in either direction (unplanned test, unimplemented ✅ case, unlisted test file).
- **New pure logic** → unit test. If the logic is buried in a service, extract it to a
  testable function first (don't test through the transport).
- **New event flow** (routing key, consumer, device interaction) → e2e case using SimDevice
  with `poll()`, **and** a zod schema + contract case for any new payload.
- **New service** → `/health` added to the platform sanity suite.
- **Firmware capability changes** → update `tools/device-sim/lib/command-models.js` and
  `tools/device-sim/PARITY.md`, then extend e2e coverage for the capability.
- Bug fixes come with a test that fails before the fix when practical.
- Tests never hard-depend on a developer's personal `.env` stack — use the harness
  constants and the ephemeral test stack.

## Firmware native unit tests (`ESP32Code`)

Host-compiled Unity tests over the firmware's pure logic — no board required. Run from
`ESP32Code/` with `pio test -e native` (needs a host g++ on PATH); also run by CI in
`firmware-checks.yml`.

| Tier | Test                                                                                   | Source under test                          | Status                            |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Unit | command-payload validation (valid list, range bounds, leading `-`, overflow, lone `-`) | `src/actions/commands/PayloadValidation.h` | ✅ `test/test_payload_validation` |
| Unit | MQTT topic construction (placeholder fill, `#`→action, device-type)                    | `src/services/TopicBuilder.h`              | ✅ `test/test_topic_builder`      |

`test_payload_validation` is the **firmware side of the command-payload parity contract** — keep
its case matrix aligned with `tests/unit/commands.command-models.test.js` (the sim side). See
`ESP32Code/CLAUDE.md` for how to add new native-testable units.

## Deferred — deliberate decisions, not omissions

- **Load/perf (k6)**: telemetry volume doesn't justify it yet; revisit when device count
  grows or ingest latency becomes a question.
- **Visual regression**: not worth the flake budget at this UI churn rate.
- **Google Home e2e**: blocked on a disposable Google test account.
