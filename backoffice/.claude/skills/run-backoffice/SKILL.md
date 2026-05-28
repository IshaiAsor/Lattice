---
name: run-backoffice
description: Build, serve, and screenshot the backoffice Angular web UI. Use when asked to run, start, build, test, or screenshot the backoffice, Angular app, admin UI, or web frontend.
---

# run-backoffice

Skill for building, serving, and visually verifying the backoffice Angular application (the admin UI for the IoT smart home system).

## Project location

`C:\Projects\iot-smart-home\backoffice\`

All paths in this document are relative to that root unless stated otherwise.

---

## Prerequisites

- Node.js installed (nvm4w is present on this machine)
- `node_modules/` must exist — run `npm install` if missing
- The backend must be running at `http://localhost:3000` for the app to function (API calls, auth, device data). Start it with `npm run dev` in `../backend/`.

---

## Dev server

```powershell
Set-Location "C:\Projects\iot-smart-home\backoffice"
npm start   # runs: ng serve
```

- Serves on **http://localhost:4200** (Angular CLI default; no custom port configured)
- Uses the `development` configuration by default, which sets `apiUrl` to `http://localhost:3000` via `src/environments/environment.development.ts`
- Hot-reload is enabled

---

## Production build

```powershell
Set-Location "C:\Projects\iot-smart-home\backoffice"
npm run build   # runs: ng build (production configuration)
```

- Output lands in **`dist/backoffice/`** (configured in `angular.json` → `outputPath`)
- Files produced: `index.html`, `main.<hash>.js`, `polyfills.<hash>.js`, `runtime.<hash>.js`, `styles.<hash>.css`, `favicon.ico`
- A bundle-size budget warning fires (initial bundle ~899 KB vs 500 KB budget) — this is a warning only, not a build failure
- Build time: ~30 s

---

## Routes / pages

Defined in `src/app/app.routes.ts`:

| Path | Component | Auth required |
|---|---|---|
| `/login` | `LoginComponent` | No |
| `/dashboard` | `UserDashboard` | Yes (authGuard) |
| `/mgmt/devices` | `MgmtDeviceListComponent` | Yes (authGuard) |
| `/mgmt/actions` | `MgmtActionListComponent` | Yes (authGuard) |
| `/` | Redirects to `/dashboard` | — |
| `/**` | Redirects to `/dashboard` | — |

Unauthenticated visitors are redirected to `/login` by `authGuard`.

---

## Environment configuration

| File | Used when |
|---|---|
| `src/environments/environment.development.ts` | `ng serve` (development build) |
| `src/environments/environment.ts` | `ng build` (production build) |

Development `apiUrl`: `http://localhost:3000`
Production `apiUrl`: `''` (empty string — app is served by the backend itself, API calls are relative)

---

## Agent-driven screenshot pattern

To visually verify the app with `chromium-cli`:

```powershell
# 1. Start dev server in background
$job = Start-Job { Set-Location "C:\Projects\iot-smart-home\backoffice"; npm start }
Start-Sleep -Seconds 15   # wait for ng serve to finish compiling

# 2. Screenshot the login page
chromium-cli screenshot http://localhost:4200/login --output login-page.png

# 3. (Optional) Screenshot dashboard (requires auth — use a test token in localStorage first)
chromium-cli screenshot http://localhost:4200/dashboard --output dashboard.png

# 4. Stop dev server
Stop-Job $job; Remove-Job $job
```

The login page (`/login`) is publicly accessible and renders the credential form with username/password fields plus a Google Sign-In button. It is the best first page to screenshot for a smoke test.

---

## Smoke test

Run `smoke.ps1` (located alongside this file) to do a headless build verification:

```powershell
& "C:\Projects\iot-smart-home\backoffice\.claude\skills\run-backoffice\smoke.ps1"
```

Exit code 0 = pass, non-zero = failure.
