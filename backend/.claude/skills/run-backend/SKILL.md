---
name: run-backend
description: Build, run, and smoke-test the backend Express API server. Use when asked to run, start, build, test, or check the backend, API server, or Express server.
---

# run-backend skill

## Project location

`C:\Projects\iot-smart-home\backend`

## Prerequisites

The backend requires three infrastructure services to be running. Start them from the project root before launching the server:

```powershell
Set-Location "C:\Projects\iot-smart-home"
docker compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- EMQX MQTT broker on port 1883

A `.env` file must exist at `C:\Projects\iot-smart-home\.env` with `DB_*`, `BACKEND_DB_*`, `MQTT_APP_*`, `JWT_SECRET`, `REDIS_USER`, `REDIS_PASSWORD`, and related vars.

## Build

```powershell
Set-Location "C:\Projects\iot-smart-home\backend"
npm run build
```

The build script runs two steps in sequence:
1. `npx prisma generate --schema ../prisma/schema.prisma` — generates the Prisma client from `C:\Projects\iot-smart-home\prisma\schema.prisma`
2. `tsc` — compiles TypeScript to `dist/`

Output: `dist/index.js` plus compiled JS for all source files.

Note: `prisma generate` prints a stderr line ("Prisma schema loaded from ...") which PowerShell surfaces as a NativeCommandError warning — this is cosmetic and does not indicate failure. The build succeeds when `dist/index.js` is present after the command completes.

## Run

```powershell
Set-Location "C:\Projects\iot-smart-home\backend"
npm start
```

The server starts on port 3000 (default) or `$env:PORT`. Successful startup log:
```
Smart Home Server running on port 3000
```

For development with hot reload (ts-node + nodemon):
```powershell
Set-Location "C:\Projects\iot-smart-home\backend"
npm run dev
```

## Smoke test

There is no dedicated `/health` or `/ping` endpoint. The root path (`GET /`) returns a plain-text response when the Angular UI is not present:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: `Smart Home API is running. (Angular UI not found in dist/public)`

The login endpoint also confirms the API is up (expects a 401 for bad credentials):

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/auth/login" -Method POST `
  -ContentType "application/json" `
  -Body '{"username":"test","password":"test"}' `
  -UseBasicParsing
```

Expected: HTTP 401 with `{"error":"Invalid credentials"}`.

## Run the smoke script

```powershell
C:\Projects\iot-smart-home\backend\.claude\skills\run-backend\smoke.ps1
```
