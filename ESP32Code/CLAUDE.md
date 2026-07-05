# CLAUDE.md — ESP32 Firmware

PlatformIO / Arduino firmware for Lattice devices. Monorepo conventions in the parent
`CLAUDE.md` apply (generic IoT naming, no commits without asking).

## Build environments (`platformio.ini`)

Four boards × test/prod (`ENV_TEST` / `ENV_PROD` flags), each with `DEVICE_TYPE_STR` +
`DEVICE_VERSION_STR` baked in:

| Env prefix | Board | Partitions |
|---|---|---|
| `esp32s3_mini-*` | esp32-s3-devkitc-1 (4MB) | `ota_partitions.csv` |
| `4d_systems_esp32s3_gen4_r8n16-*` | 4D Systems Gen4 | default |
| `esp32wrover_e-*` | esp32dev + PSRAM | `wrover_e_partitions.csv` |
| `esp32s3_cam-*` | esp32-s3-devkitc-1 (8MB, `HAS_CAMERA`, pin map in flags) | `s3_cam_partitions.csv` |

```bash
pio run -e esp32s3_mini-test                   # build
pio run -e esp32s3_mini-test --target upload   # flash
pio device monitor                             # 115200 baud
```

`Dockerfile.firmware` + `entrypoint.sh` build firmware in CI (`esp32-ota-ci.yml`).

## Code layout & style

- **Header-only style**: logic lives in `.h` files; `src/main.cpp` is the single
  translation unit. Match this — don't introduce `.cpp` modules.
- `src/actions/commands/` — actuator actions extending `BaseCommandAction.h` (payload
  validation lives here).
- `src/actions/telemtries/` — sensor actions extending `BaseTelemtryAction.h`
  (directory name spelling is historical; keep it).
- `src/actions/manifest/` — `CapabilityRegistry`, Google trait mapping.
- `src/services/` — WiFi/BLE provisioning, MQTT, OTA, JWT, camera, live stream.
- `src/config/settings.h` — build-time configuration; `src/certs/` — TLS roots.

## Capability manifest generation

`tools/manifest-gen` compiles the firmware's action classes **natively on the host** to
emit the master capability catalog (consumed by seeding; provisioning is validate-only).
Requires a host C++ compiler — MinGW g++ on this machine. Entry point:
`tools/generate-manifests.mjs`.

## Parity rule (mandatory)

Any change to device capabilities — new action, changed payload validation, new telemetry —
must update, in the same change:

1. `../tools/device-sim/lib/command-models.js` (mirrors `BaseCommandAction::validateActionPayload`)
2. `../tools/device-sim/PARITY.md` (the parity table)
3. Regenerated manifests if action metadata changed

The e2e suites test against the simulator; unmirrored firmware behavior is untested behavior.
