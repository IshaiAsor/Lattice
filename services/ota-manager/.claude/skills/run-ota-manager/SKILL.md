---
name: run-ota-manager
description: Run, start, build, and check the OTA manager firmware update service. Use when asked to run, start, check, or test the OTA manager, firmware update service, or OTA service.
---

Node.js HTTP service that serves firmware `.bin` downloads to ESP32 devices and announces loaded
firmware onto RabbitMQ. It **never touches MQTT** — `mqtt-service` owns that. No frontend. The
driver is `smoke.ps1` (syntax check) plus `curl` for live smoke tests.

Paths are relative to `services/ota-manager/`. This is an npm workspace member; it consumes
`@lattice/logger` and `@lattice/queue`, so install/build from the repo root (not standalone).

## Prerequisites

Node.js (v18+) must be installed.

On a fresh machine:

```powershell
Set-Location "C:\Projects\iot-smart-home"
npm install
npm run build:libs   # builds @lattice/logger + @lattice/queue (required at runtime)
```

## Smoke check (agent path -- no broker needed)

```powershell
powershell -File .claude\skills\run-ota-manager\smoke.ps1
```

Verifies `index.js` syntax and reports the contents of `firmware/` (the storage directory). Exits 0 on success.

## Start the service

Requires RabbitMQ running -- start it first:

```powershell
Set-Location "C:\Projects\iot-smart-home"
docker compose up -d rabbitmq
```

Then start the OTA manager:

```powershell
Set-Location "C:\Projects\iot-smart-home\services\ota-manager"
node index.js
```

The service listens on `http://localhost:3000` by default (Docker Compose maps it to host port 3001).

## Environment variables

| Variable        | Default             | Purpose                                                         |
| --------------- | ------------------- | --------------------------------------------------------------- |
| `PORT`          | `3000`              | HTTP listen port                                                |
| `FIRMWARE_PATH` | `./firmware`        | Where `.bin` files are stored                                   |
| `RABBITMQ_URL`  | `amqp://localhost`  | Broker to announce firmware on (`q.ota.incoming`)               |
| `JWT_SECRET`    | (required for auth) | Verifies device `device_usage` JWTs on `/download` and `/check` |

## Authentication

- `/download` + `/check` require a device `device_usage` JWT — `Authorization: Bearer <jwt>`
  (or `?token=<jwt>` on `/download`). Missing → 401, invalid/wrong purpose → 403.
- All endpoints are rate limited (global 100 / 15 min / IP).

## Firmware distribution (read-only service)

The service does **not** accept firmware uploads. Publishing is GitOps/Kargo-driven: CI builds the
`lattice-firmware` image → Kargo promotes the image tag → the ota-manager init container's
`entrypoint.sh` writes `<version>.bin` + `latest.json` per device → on startup this process
**publishes `q.ota.incoming`** for each → digest-service validates/audits it.

That chain ends there: a release is an **announcement**, and digest deliberately does not forward
it to devices (`ota-incoming.consumer.ts`). Actually updating a device is user-initiated —
device-gateway's `applyUpdate` stages the pending version and publishes `q.ota.dispatch`, and
`mqtt-service` sends it to that one device as an `ota` command on its own topic. Nothing is
published to a device type, and nothing is retained.

## API endpoints

| Method | Path                                   | Purpose                                   |
| ------ | -------------------------------------- | ----------------------------------------- |
| `GET`  | `/check?deviceType=ESP32S3_Mini`       | Get latest firmware metadata (device JWT) |
| `GET`  | `/download/{deviceType}/{version}.bin` | Download a firmware binary (device JWT)   |

### Check latest firmware

```powershell
curl -H "Authorization: Bearer <device_usage_jwt>" "http://localhost:3000/check?deviceType=ESP32S3_Mini"
```

Returns JSON with `version`, `url`, `releaseNotes`, `timestamp`.

## Firmware storage layout

```
firmware/
  {deviceType}/
    latest.json        <- metadata (version, url, releaseNotes, timestamp)
    {version}.bin      <- the binary
```

On startup, each device's `latest.json` is published to `q.ota.incoming`, and the chain ends there —
digest-service validates and audits it, but a release is an announcement and reaches no device on
its own. A device is updated only when a user asks: device-gateway stages the pending version and
publishes `q.ota.dispatch`, and `mqtt-service` sends it as an `ota` command on that one device's
topic. `latest.json` is produced by the init container's `entrypoint.sh`, not by this process.

## Gotchas

- **RabbitMQ at startup** -- On boot the service announces firmware to `q.ota.incoming`. If RabbitMQ is unreachable it logs and retries with backoff; the HTTP server still starts and serves downloads regardless.
- **Read-only** -- No upload/release endpoint, no MQTT. New firmware lands via the Kargo-promoted `lattice-firmware` image + init container; a pod restart re-announces (idempotent — devices skip same/older versions).
- **`firmware/` is auto-created** -- The directory is created at startup if it doesn't exist; no manual setup needed.
- **Download URL** -- `latest.json`'s `url` is built by `entrypoint.sh` from `OTA_BASE_URL` (the public OTA host, set per overlay).
