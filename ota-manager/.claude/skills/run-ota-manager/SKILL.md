---
name: run-ota-manager
description: Run, start, build, and check the OTA manager firmware update service. Use when asked to run, start, check, or test the OTA manager, firmware update service, or OTA service.
---

Node.js HTTP + MQTT service that accepts firmware `.bin` uploads and broadcasts OTA update notifications to ESP32 devices. No frontend -- all interaction is via HTTP API and MQTT. The driver is `smoke.ps1` (syntax check) plus `curl` for live smoke tests.

Paths are relative to `ota-manager/`.

## Prerequisites

Node.js (v18+) must be installed. Dependencies are already installed in `node_modules/`.

On a fresh machine:

```powershell
Set-Location "C:\Projects\iot-smart-home\ota-manager"
npm install
```

## Smoke check (agent path -- no MQTT needed)

```powershell
powershell -File .claude\skills\run-ota-manager\smoke.ps1
```

Verifies `index.js` syntax and reports the contents of `firmware/` (the storage directory). Exits 0 on success.

## Start the service

Requires MQTT broker (EMQX) running -- start the full stack first:

```powershell
Set-Location "C:\Projects\iot-smart-home"
docker compose up -d emqx
```

Then start the OTA manager:

```powershell
Set-Location "C:\Projects\iot-smart-home\ota-manager"
node index.js
```

The service listens on `http://localhost:3000` by default (Docker Compose maps it to host port 3001).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `FIRMWARE_PATH` | `./firmware` | Where `.bin` files are stored |
| `MQTT_INTERNAL_HOST` | `emqx` | MQTT broker hostname |
| `MQTT_PORT` | `8883` | MQTT broker port |
| `MQTT_APP_USERNAME` | (required) | MQTT auth username |
| `MQTT_APP_PASSWORD` | (required) | MQTT auth password |
| `MQTT_CA_CERT_PATH` | (optional) | Path to CA cert (enables TLS) |
| `MQTT_VALIDATE_CERT` | `false` | Whether to validate server cert |
| `MQTT_SERVER_NAME` | (optional) | SNI override for TLS |

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/check?deviceType=ESP32_SmartOutlet` | Get latest firmware metadata for a device type |
| `POST` | `/release` | Upload a new firmware binary (multipart: `firmware`, `deviceType`, `version`, `releaseNotes`) |
| `GET` | `/download/{deviceType}/{version}.bin` | Download a firmware binary directly |

### Release a new firmware version

```powershell
curl -X POST http://localhost:3000/release `
  -F "firmware=@path\to\firmware.bin" `
  -F "deviceType=ESP32_SmartOutlet" `
  -F "version=V1.2.0" `
  -F "releaseNotes=Bug fixes"
```

Version must be strictly higher than the currently released version (semver comparison). Format: `Vmajor.minor.patch`.

### Check latest firmware

```powershell
curl "http://localhost:3000/check?deviceType=ESP32_SmartOutlet"
```

Returns JSON with `version`, `url`, `releaseNotes`, `timestamp`.

## Firmware storage layout

```
firmware/
  {deviceType}/
    latest.json        <- metadata (version, url, releaseNotes, timestamp)
    {version}.bin      <- the binary
```

MQTT publishes to `ota/updates/{deviceType}` (retained, QoS 1) on each `/release` call. ESP32 devices subscribed to that topic receive the update notification automatically.

## Gotchas

- **MQTT connection at startup** -- The service connects to MQTT immediately on start. If EMQX isn't running, it logs a connection error but the HTTP server still starts and serves requests. MQTT reconnects automatically every 1 second.
- **Version must be strictly higher** -- Releasing `V1.0.0` when `V1.0.0` is already published returns HTTP 409. Use `V1.0.1` or higher.
- **`firmware/` is auto-created** -- The directory is created at startup if it doesn't exist; no manual setup needed.
- **Download URL uses `req.get('host')`** -- The URL embedded in `latest.json` uses the HTTP `Host` header. Behind a reverse proxy, ensure the proxy passes the correct hostname.
