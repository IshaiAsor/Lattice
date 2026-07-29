# Architecture (current state)

What the system _is_ today. Plans and history live in
[SYSTEM-DESIGN-ROADMAP.md](../SYSTEM-DESIGN-ROADMAP.md).

## Services

| Service             | Port*            | Role                                                                                         |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `api`               | 3000 (host 3100) | HTTP API for the UI: auth, users, device management, catalog, rules, pipelines               |
| `device-gateway`    | 3004             | Device provisioning (single-call, capability-blueprint based) and device-facing HTTP         |
| `mqtt-service`      | 3005             | MQTT ↔ RabbitMQ bridge: subscribes device topics, publishes commands/OTA to devices          |
| `digest-service`    | 3006             | Central event processor: resolves/persists telemetry, action state, pictures, OTA validation |
| `socket-server`     | 3007             | Socket.IO push to the Angular UI (device status, action state, telemetry)                    |
| `automation-worker` | 3008             | Rule evaluation triggered by telemetry                                                       |
| `ml-router`         | 3009             | ML orchestration brain: pipeline stages, enrichment, prompt building, policy                 |
| `ml-executor`       | 3002             | Pure inference executor (ONNX local / Ollama proxy), HTTP + per-model queues                 |
| `google-home`       | 3010             | Google Smart Home intents (SYNC/QUERY/EXECUTE) + HomeGraph report-state                      |
| `ota-manager`       | 3001             | Firmware storage + OTA release intake                                                        |
| `backoffice`        | —                | Angular UI (nginx image in deploys)                                                          |

\* container default from each service's `env.config.ts`.

**Infra (compose / cluster):** EMQX (1883 mqtt, 8883 tls, 18083 dashboard), PostgreSQL,
RabbitMQ, Valkey (cache), Adminer.

## Event flow

```
ESP32 / SimDevice
   │  MQTT  users/{userId}/devices/{deviceId}/{version}/{channel}/{action}
   ▼         channels: status | telemetry | command | ack | ota
mqtt-service  ── publishes to RabbitMQ exchange `iot` (topic) ──▶  @lattice/queue RKs
   │
   │  telemetry.arrived fans out to two independent queues (topic exchange):
   ├──▶ digest-service ── persists state (Prisma/PostgreSQL, Valkey cache), resolves
   │      │                pending requests, emits socket events
   │      ├──▶ socket-server ──▶ Angular UI (Socket.IO)
   │      ├──▶ automation-worker (rules.evaluate on every scalar write)
   │      └──▶ google-home (q.action.result.google-home → HomeGraph report-state)
   └──▶ automation-worker ── matches pipeline sensor_threshold triggers, publishes
                             pipeline.trigger (cooldown persisted on the trigger row)

UI intent:  api → action.requested → digest (optimistic write) → action.dispatch
            → mqtt-service → device → ack → action.result → digest (authoritative write)

ML pipeline: pipeline.trigger (from automation-worker's sensor_threshold match, or a
             manual/scheduled run) → ml-router stages (sensor_digest / command_exec /
             per-model q.pipeline.stage.{kind}.{name}.{version} on ml-executor)
             → pipeline.stage.done.v1 → pipeline.result
             Fresh camera frames via picture.requested / picture.result.

OTA: ota-manager → ota.incoming → digest (validate) → ota.dispatch → mqtt-service → device
```

**The event contract is `packages/queue/src/index.ts`** — `RK` (routing keys), `QUEUES`,
payload types in `types.ts`. Routing keys are static; `userId` lives in payloads, never in
keys. Every queue dead-letters to `q.dlq` (fanout `iot.dlq`) with a 5-minute message TTL.

## Data layer

- **PostgreSQL via Prisma** — schema at `prisma/schema.prisma`, documented in
  [prisma/SCHEMA.md](../prisma/SCHEMA.md) (keep in sync). Migrations run as a dedicated
  `migrate` container before services start; app-row seeds live in `prisma/seed.ts`.
- **Valkey** — cache for pending action requests, Google HomeGraph state, hot device state.

## Auth

- JWT purposes: `app_usage` (UI sessions), `device_usage` (device MQTT auth),
  `provisioning` (one-time device setup). Issued/verified via `@lattice/jwt`.
- EMQX auth is two-layer: devices present `device_usage` JWTs; backend services use the
  app superuser credential (PostgreSQL bcrypt). ACL rules in `acl.conf`.

## Delivery

- One GitHub workflow per service builds and pushes its image, then bumps the shared
  `vX.Y.Z` tag via `.github/actions/bump-version-tag` (retry-on-conflict; do not replace
  with job concurrency groups — they cancel instead of queueing).
- `checks.yml` is the quality gate (typecheck, lint, format, tests).
- Deployment is pull-based from the `oci-k3s-gitops` repo: Kargo auto-promotes to staging
  (`lattice-stg`), prod is manual. See that repo's CLAUDE.md.
