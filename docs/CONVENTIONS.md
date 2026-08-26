# Coding Conventions

These codify the patterns already in use. When adding code, match these; when you find code
that violates them, fix it in a focused change (don't mix with feature work).

## Logging

Shared package: `@lattice/logger` (pino). Never `console.log` in services or packages.

```ts
import { createLogger, createHttpLogger } from '@lattice/logger';

const log = createLogger('mqtt-service'); // service root
const log = createLogger('digest-service:telemetry'); // sub-module: '<service>:<area>'
```

- Structured, object-first: `log.info({ userId, deviceId }, 'telemetry received')` —
  context object first, human message second. Errors go under the `err` key:
  `log.error({ err }, 'MQTT error')` (pino serializes it).
- HTTP services use `createHttpLogger(log)` (pino-http; `/health` and `/metrics` are ignored).
- `LOG_LEVEL` env controls level (debug in dev, info in prod); pretty transport is dev-only.
- `initOTel('<service>')` runs before `createLogger` so trace/span ids are injected into
  every line (Loki ↔ Tempo correlation).

## Error handling

- **HTTP**: services throw errors with a `statusCode` property; the exception middleware
  (`services/api/src/middlewares/exception.middleware.ts`) maps them — 5xx logged as
  `error`, 4xx as `warn`, response body `{ error: message }`. Async route handlers wrap
  their body in `try { ... } catch (err) { next(err); }` — Express 4 does not route
  rejected promises to middleware on its own, so a missing catch means a hung request.
- **Queue consumers**: `@lattice/queue`'s `consume()` wraps every handler — on throw it
  nacks without requeue and the message dead-letters to `q.dlq`. Therefore: **throw on
  unrecoverable input** (unknown ids, malformed payloads) so it lands in the DLQ; never
  swallow and ack bad messages. Retryable infra errors should also throw — the message TTLs
  to DLQ after 5 min rather than poison-looping.
- **Startup**: `main().catch((err) => log.error({ err }, 'Fatal startup error'))`.
- **Infra drop = fail fast**: on RabbitMQ/MQTT connection or channel close, log and
  `process.exit(1)` — the container restart is the recovery mechanism.

## Service structure

Every Node service follows this shape (see `services/mqtt-service` and
`services/digest-service` as references):

```
src/
  index.ts            # bootstrap: initOTel → createLogger → connect infra → wire consumers/
                      # handlers → express (httpLogger, health router, /metrics) → main().catch
  config/env.config.ts# the ONLY place that reads process.env; exports a typed `env` object
                      # with defaults: parseInt for numbers, bracket access process.env['X']
  routes/             # HTTP endpoints; health.routes.ts is mandatory
  handlers/           # protocol-in (e.g. MQTT message handlers)
  consumers/          # queue-in (RabbitMQ consumers; factory fn returning async handler)
  services/           # business logic (api-style services)
```

- Naming: `<domain>.<layer>.ts` — `auth.routes.ts`, `login.service.ts`,
  `telemetry.consumer.ts`, `device-status.handler.ts`.
- Routes are thin delegates (see CLAUDE.md working rules).
- Every service exposes `GET /health` and `GET /metrics` (Prometheus via `@lattice/otel`).

## Shared packages (`packages/`, scoped `@lattice/*`)

| Package                          | Purpose                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@lattice/logger`                | pino logger + pino-http factories                                                                                                |
| `@lattice/otel`                  | OpenTelemetry init, Prometheus metrics handler, trace-id log mixin                                                               |
| `@lattice/queue`                 | RabbitMQ layer: `connect`/`publish`/`consume`, **the `RK`/`QUEUES` event contract**, DLQ topology                                |
| `@lattice/prisma-client`         | shared Prisma client wrapper                                                                                                     |
| `@lattice/jwt`                   | JWT signing/verification (purposes: `app_usage`, `device_usage`, `provisioning`)                                                 |
| `@lattice/ioredis`               | Valkey/Redis client + types                                                                                                      |
| `@lattice/ml`                    | ML types/helpers                                                                                                                 |
| `@lattice/capability-validation` | device capability validation                                                                                                     |
| `@lattice/params`                | blueprint parameter refs, resolution, schedules, thresholds                                                                      |
| `@lattice/retention`             | retention arithmetic: bucket flooring, tier resolution across scopes, keep-window clamping, rollup folding, query-tier selection |

Rules:

- Logic used by ≥2 services belongs in a package, not copied.
- Services depend via `"@lattice/x": "*"` and import bare specifiers.
- Packages build to `dist/`; `npm run build:libs` builds them in dependency order — keep
  that script's order correct when adding a package.
- **A new package is four edits, not one.** `build:libs`, the root `tsconfig.json` references, the
  consuming service's `package.json`, **and that service's `Dockerfile`** — which enumerates every
  `@lattice` package by hand in both stages (`COPY packages/x`, the `npm run build -w` chain, and
  the runtime `package.json` + `dist` copy). Miss the Dockerfile and everything passes locally while
  the image build fails in CI.
- Cross-service event changes (new routing key, payload shape) happen in `@lattice/queue`
  (`RK`, `QUEUES`, `src/types.ts`) first; consumers/producers reference the constants.

## Config

- Per-service `src/config/env.config.ts` exports a plain `env` object grouped by concern
  (`env.mqtt`, `env.jwt`, …). Defaults inline; no validation library.
- Nothing else reads `process.env`. Compose files + `.env` / `.env.test` supply values.

## Formatting & types

- Prettier (root `.prettierrc`: single quotes, semi, trailing commas, width 100, 2-space)
  owns all style questions. `.editorconfig` mirrors it for non-prettier files.
- `tsconfig.base.json` is `strict: true` + composite/project-references; every workspace
  extends it. Don't loosen compiler options per-workspace.
- ESLint (flat config at root) runs typescript-eslint type-checked rules on
  `services/`, `packages/`, `tests/` — correctness only (floating promises, unused vars);
  no stylistic rules.

## Firmware (C++, `ESP32Code/`)

The firmware has its own toolchain (PlatformIO/Arduino) — see `ESP32Code/CLAUDE.md` for the full
guide. The conventions that rhyme with the TS side:

- **Leveled logging, never raw `Serial.print*` for log output** — the firmware analog of "never
  `console.log`". Use `LOG_E/W/I/D(tag, fmt, ...)` from `src/config/Log.h`; prod builds compile out
  `LOG_D` (zero flash). Structured-ish `[LEVEL][Tag]` prefix, terse lowercase message, secrets by
  length only — same spirit as `@lattice/logger`.
- **Formatting** is `.clang-format` (own style: Allman/4-space, matching existing firmware), enforced
  by the same lint-staged + CI machinery via the `clang-format-node` devDependency.
- **Static analysis + tests**: `pio check` (cppcheck) and `pio test -e native` gate PRs in
  `firmware-checks.yml`; pure logic that can be host-tested goes in Arduino-free headers.
- **Parity rule** still governs capability/behavior changes — mirror them in the simulator
  (`tools/device-sim`) and `PARITY.md`.
