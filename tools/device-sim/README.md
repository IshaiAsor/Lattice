# device-sim (`@lattice/device-sim`)

Software ESP device simulator. **Pure HTTP + MQTT (+ camera WS/HTTP)** — the same surface a real
ESP touches, with no DB shortcut — so it can both run as a CLI and be imported as a fixture for
automated tests. It provisions, **pulls its configuration** from the device-gateway config endpoint
(mirroring firmware `DynamicDeviceActionsService::loadFromServer`), and drives telemetry/commands
from _that_ — i.e. only the capabilities a user activated in the UI.

See [PARITY.md](PARITY.md) for the firmware↔sim feature matrix — what's mirrored, partial, or
intentionally not simulated. Keep it updated when firmware behavior changes.

## Prereqs

- `docker compose up -d` (EMQX 1883, postgres, redis/valkey, rabbitmq)
- Migrate + seed + catalog (runs `prisma migrate deploy && prisma db seed && seed-catalog.ts`):
  `docker compose run --rm migrate`. Set `OWNER_USERNAME`/`OWNER_PASSWORD` in `.env` first — the
  seed creates a login-able admin **only** when both are set (that's the account the sim/tests use).
- New services running (VS Code **All Backend Services (dev)** incl. **Debug API** on 3100):
  api, device-gateway, mqtt-service, digest-service, socket-server (+ automation-worker for rules)
- `npm install` at the repo root (installs the sim's `mqtt`/`ws` deps via the workspace)

## Run (CLI)

```bash
node tools/device-sim/index.js          # or: npm start -w @lattice/device-sim
```

Or use the **Run Device Sim** VS Code launch config (after the backend compound is up).

Then open the backoffice (`ng serve`, log in admin/admin): the device shows **online**, action
cards populate, scalar telemetry updates live, toggling a command action acks back (the card leaves
its pending state because the sim echoes the `commandId`), and a threshold rule fires when a
reading crosses it. `Ctrl-C` stops (publishes offline).

By default `ACTIVATE_ALL=true` activates every catalog capability through the **real api**
(`POST /api/devices/:id/actions`) so a fresh device has something to drive. Set `ACTIVATE_ALL=false`
to instead drive **only** what you activate by hand in the device-config UI — the sim re-pulls its
config every `CONFIG_REFRESH_MS`, so activations/deactivations take effect live without a restart.

For camera, run a camera device type, e.g. `DEVICE_TYPE=ESP32S3_CAM node tools/device-sim/index.js`.

## Run a fleet (multiple devices/types from config)

To start several devices at once — different types, several instances of each — use a JSON
config instead of one-device-per-process env vars:

```bash
cp tools/device-sim/fleet.example.json tools/device-sim/fleet.json   # gitignored, edit freely
node tools/device-sim/index.js tools/device-sim/fleet.json
# or: node tools/device-sim/index.js --config tools/device-sim/fleet.json
# or: FLEET_CONFIG=tools/device-sim/fleet.json node tools/device-sim/index.js
```

Or use the **Run Device Fleet** VS Code launch config (copy `fleet.json` first).

Config shape:

```json
{
  "defaults": { "activateAll": true },
  "devices": [
    { "type": "ESP32S3_MINI", "count": 3, "capabilities": ["outlet", "temperature"] },
    { "type": "ESP32S3_CAM", "count": 1, "camera": true },
    { "type": "ESP32S3_WROVER", "count": 2, "telemetryMs": 2000 }
  ]
}
```

- `defaults` — optional opts (any `SimDevice` opt except `mac`) applied to every device.
- `devices[]` — one entry per device group: `type` (required, matches a catalog `DeviceType`),
  `count` (default 1), plus any per-group opt overrides (`telemetryMs`, `camera`, `persist`,
  `capabilities`, ...).
- `capabilities` — optional list of catalog `capability_key`s (e.g. `outlet`, `temperature`,
  `humidity` — check the device type's manifest under `ESP32Code/tools/manifest-gen/out/` or
  `GET /api/admin/catalog/devices/:id/capabilities` for the full list per type) to activate only
  those, instead of every capability the type has. Works whether or not `activateAll` is set —
  an explicit `capabilities` list is itself a request to activate that subset. An unknown key
  logs a warning and is skipped rather than failing the run.
- `mac` — omit to auto-generate `SIM-<TYPE>-<NN>` (numbered per type across the whole fleet, so
  two groups of the same type don't collide). Give an explicit `mac` on a `count: 1` group to
  pin it; on a `count > 1` group it's used as a prefix (`<mac>-01`, `<mac>-02`, ...). Duplicate
  MACs across the fleet are rejected before anything starts.
- The connection/credential env vars (`API_URL`, `GATEWAY_URL`, `MQTT_*`, `SIM_USER`/`SIM_PASS`)
  still apply — they're shared by every device in the fleet. `DEVICE_TYPE`/`MAC`/`TELEMETRY_MS`/
  etc. env vars are ignored in fleet mode (the config file drives those per device).
- `DRY_RUN=true` prints each device's computed opts (including generated MACs) and exits without
  starting anything or touching the network — useful for checking the merge/MAC logic quickly.
- Devices start staggered (~150ms apart) and run independently — one device's error or
  `hard-reset` doesn't stop its siblings. `Ctrl-C` stops the whole fleet.

## Control commands (resets + OTA)

The sim honours the same control commands the firmware does
([MqttActionsHandlerService](../../ESP32Code/src/services/MqttActionsHandlerService.h)):

| trigger                      | sim behavior                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `restart`                    | offline → drop MQTT → reconnect (creds kept) → re-pull config                                                                                                                                                                              |
| `soft-reset` / `reprovision` | offline → re-provision (fresh device JWT) → reconnect → re-pull                                                                                                                                                                            |
| `hard-reset`                 | offline → disconnect → emit `hard-reset` (CLI exits)                                                                                                                                                                                       |
| OTA on `ota/updates/<type>`  | if strictly newer: ack `starting:<v>`, adopt the version, "reboot", reconnect on the **new** version topic (UI's `current_firmware_version` updates); if not newer: ack `rejected:not-newer`; with `OTA_FAIL=true`: ack `failed:` and stay |

Like firmware, the reset/restart commands are **not** acked (the device reboots instead).

## Env overrides

`API_URL`, `GATEWAY_URL`, `MQTT_HOST`, `MQTT_PORT`, `SIM_USER`/`SIM_PASS`, `DEVICE_TYPE`
(ESP32S3_MINI/CAM/WROVER/GEN4_GENERIC), `MAC`, `TELEMETRY_MS`, `CAMERA_MS`, `CONFIG_REFRESH_MS`,
`CONFIG_REFRESH_MS` (periodic config re-pull; default 60000, `0` disables — real firmware only
pulls at boot), `ACTIVATE_ALL=false`, `CAPABILITIES=outlet,temperature` (comma-separated catalog
`capability_key`s — activate only these; see the "Run a fleet" section above for where to find
valid keys), `CAMERA=false`, `CAMERA_RESOLUTION=SVGA`, `CAMERA_TRANSPORT=ws` (default `http`;
sent when auto-activating a camera capability, and read back to pick which transport periodic
frames and on-demand `take_picture` captures use), `RESTART_ON_LOSS=true` (mimic ESP.restart on disconnect),
`OTA_FAIL=true`, `PERSIST=false` (skip the on-disk NVS state file), `CLEANUP_ON_EXIT=true`,
`REFRESH_LEAD_MS=450000` (refresh the device JWT this long before it expires; lower this to force
a near-immediate `refresh-token` round trip for testing — e.g. `REFRESH_LEAD_MS=86399000` against
the default 86400s `JWT_DEVICE_USAGE_EXPIRES_IN` refreshes ~1s after boot).
Any of these left unset falls back to the library's own default (e.g. `ACTIVATE_ALL` unset →
`true`) — an unset var used to silently override the library default with `undefined` instead of
falling back to it; fixed alongside the fleet-config work above.

## Library API (for tests / scripting)

```js
const { SimDevice } = require('@lattice/device-sim'); // or require('../tools/device-sim/lib/sim-device')
const dev = new SimDevice({
  deviceType: 'ESP32S3_CAM',
  persist: false,
  autoTelemetry: false,
  log: console.log,
});
await dev.start(); // login→catalog→provision→activate→pullConfig→connect
dev.publishTelemetry('humidity', 42);
const ack = await dev.waitFor('ack', (a) => a.commandId === id, 5000); // awaitable event hook
await dev.cleanup(); // disconnect + delete the device via the api
```

`lib/fleet-config.js` exports `loadFleetConfig(config, baseOpts)` — the pure config-merging/MAC-
generation logic behind fleet mode (no I/O), plus `compact`/`checkMacCollisions` if you want them
directly. Unit-tested in `tests/unit/fleet-config.test.js`.
Key methods: `start()`, `login()`, `loadCatalog()`, `provision()`, `activateAll()`, `pullConfig()`,
`connect()`, `publishTelemetry(name, value)`, `publishStatus(s)`, `refreshTokenNow()`,
`reboot({reprovision})`, `stop()`, `cleanup()`, `waitFor(event, predicate?, timeoutMs)`.
Events: `connect, config, command, ack, telemetry, camera-frame, ota, reboot, refresh, offline,
hard-reset, error`. All config is via constructor `opts` (no env reads); see `DEFAULTS` in
[lib/sim-device.js](lib/sim-device.js).

## Automated tests

The repo root runs **Jest** (`jest.config.js`):

- `npm test` — everything (unit + e2e). Unit tests (e.g. `tests/unit/command-models.test.js`) run
  anywhere; e2e tests **skip cleanly** when the stack is down.
- `npm run test:e2e` — the stack-driven suite (`tests/e2e/device-sim.e2e.test.ts`) using `SimDevice`
  as the fixture: provision→online, telemetry→state, valid/invalid command acks, duration auto-off.
  Command round-trips need the app MQTT creds (`MQTT_APP_USERNAME`/`MQTT_APP_PASSWORD`, loaded from
  the root `.env`); those cases skip if absent. Helpers live in `tests/e2e/helpers/stack.ts`.

## What it does (CLI flow)

1. `POST /api/auth/login` → app JWT
2. `GET /api/admin/catalog/devices` + `…/:id/capabilities` → the device type's blueprint
3. `GET /api/provisioning/provision-token` → provisioning token
4. `POST /api/provisioning/provision` → `{deviceId, mqttToken, deviceConfigUrl, refreshToken, …}`
5. (if `ACTIVATE_ALL`) activate not-yet-configured capabilities via `POST /api/devices/:id/actions`
6. **`GET {deviceConfigUrl}?deviceId&version`** (device JWT) → the device's _active_ actions
7. MQTT connect; subscribe `…/command/#` + `ota/updates/<type>`; publish `status=online` (LWT offline)
8. drive telemetry per action interval; camera frames over WS/HTTP; per-type command validation +
   ack (echoing `commandId`); duration auto-off; NVS-style state restore; token refresh near expiry;
   resets + OTA per the table above
