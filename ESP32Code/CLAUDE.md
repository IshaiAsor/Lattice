# CLAUDE.md — ESP32 Firmware

PlatformIO / Arduino firmware for Lattice devices. Monorepo conventions in the parent
`CLAUDE.md` apply (generic IoT naming, no commits without asking).

## Build environments (`platformio.ini`)

Four boards × test/prod (`ENV_TEST` / `ENV_PROD` flags), each with `DEVICE_TYPE_STR` +
`DEVICE_VERSION_STR` baked in. Shared on-device options live in the `[hw]` section, which each
hardware env `extends`; identity flags stay per-env (two CI parsers read them line-by-line — see
the header comment in `platformio.ini`). `[hw]` is deliberately **not** `[env]` so the host
`[env:native]` test build doesn't inherit `platform=espressif32`.

| Env prefix | Board | Partitions | OTA slot |
|---|---|---|---|
| `esp32s3_mini-*` | esp32-s3-devkitc-1 (4MB) | `ota_partitions.csv` | **0x1E0000 (1.92 MB) — the binding size constraint** |
| `4d_systems_esp32s3_gen4_r8n16-*` | 4D Systems Gen4 | default | — |
| `esp32_wroom32e-*`, `esp32_wroom32d-*` | esp32dev — classic ESP32-D0WD (4MB). Same board/flags for both; separate envs only to give WROOM-32E and WROOM-32D their own catalog identity | `ota_partitions.csv` | 0x1E0000 (1.92 MB) |
| `esp32s3_cam-*` | esp32-s3-devkitc-1 (8MB, `HAS_CAMERA`, pin map in flags) | `s3_cam_partitions.csv` | 3 MB |

```bash
pio run                                        # build all 18 default (hardware) envs
pio run -e esp32s3_mini-test                   # build one
pio run -e esp32s3_mini-test --target upload   # flash
pio device monitor                             # 115200 baud
pio test -e native                             # host unit tests (needs g++ on PATH)
pio check -e esp32s3_mini-test --fail-on-defect high --fail-on-defect medium   # cppcheck
npx clang-format -i --style=file src/**/*.h    # format (run from repo root; lint-staged does this on commit)
```

`Dockerfile.firmware` + `entrypoint.sh` build firmware in CI (`esp32-ota-ci.yml`). PRs additionally
run `firmware-checks.yml` (clang-format, native tests, cppcheck, compile smoke + a size gate that
fails at ≥95% of the mini OTA slot).

## Conventions (formatting, logging, TLS)

- **Formatting** is enforced by `.clang-format` (Allman braces, 4-space indent, 120 cols,
  `SortIncludes: Never` — include order is load-bearing in Arduino code). `src/certs/` has its own
  `.clang-format` with `DisableFormat: true` (never reflow PEM literals). The pinned formatter is
  the `clang-format-node` devDependency (repo root); `npx clang-format` and CI use the same binary.
- **Logging**: never `Serial.print*` for log output. Use the leveled macros in `src/config/Log.h`:
  `LOG_E / LOG_W / LOG_I / LOG_D(tag, fmt, ...)` → `[I][Tag] message`. Levels below `LOG_LEVEL`
  compile to `((void)0)` (zero flash), so **prod builds default to INFO and carry no DEBUG strings**
  — this is also the firmware's biggest size lever, so keep chatty diagnostics at `LOG_D`. Override
  with `-D LOG_LEVEL=LOG_LEVEL_x`. Raw `Serial` is kept only for `Serial.begin`, the boot CDC wait,
  and progress dots (WiFi/NTP). Never log secrets — the JWT and tokens are logged by length only.
- **TLS**: prod always validates against the pinned CA in `src/certs/` (there is no `setInsecure`
  fallback and no `validateCACert` flag — the platform still sends the field for old firmware, but
  new firmware ignores it). `ENV_TEST` uses plain (non-TLS) transports.
- **BLE is NimBLE, never Bluedroid.** Provisioning uses `NimBLEDevice.h` (`h2zero/NimBLE-Arduino`).
  Including any Arduino Bluedroid header (`BLEDevice.h`, `BLEServer.h`, `BLE2902.h`, …) links
  `libbt.a` back in — that was **587 KB, 30% of the image**, and it is what put the classic-ESP32
  builds at 99.7% of their 1.92 MB OTA slot. The swap freed 512 KB (F3.19). NimBLE creates the
  0x2902 CCCD itself for NOTIFY characteristics, so never add one by hand; callback overrides take
  a trailing `NimBLEConnInfo&` and a wrong signature compiles but is silently never called.

## Code layout & style

- **Header-only style**: logic lives in `.h` files; `src/main.cpp` is the single
  translation unit. Match this — don't introduce `.cpp` modules.
- `src/actions/DeviceAction.h` — the **unified action base**. Command and telemetry are no
  longer separate trees but two optional *surfaces* of one `DeviceAction` (command: `execute` +
  NVS state + acks; read: cyclic + on-demand `readNow`). One `std::vector<DeviceAction*>` in
  `DynamicDeviceActionsService`; `MqttActionsHandlerService` dispatches by **verb**. Per-instance
  behaviors (`command`/`interval`/`on_demand`, from the served config) gate each surface.
- `src/actions/commands/` — command-surface leaves extending `BaseCommandAction.h` (payload
  validation lives here); override only `executeValidAction`.
- `src/actions/telemetries/` — read-surface leaves extending `BaseTelemetryAction.h`; override
  only `executeTelemetryAction`.
- `src/actions/manifest/` — `CapabilityRegistry`, Google trait mapping.
- `src/services/` — WiFi/BLE provisioning, MQTT, OTA, JWT, camera, live stream.
- `src/config/settings.h` — build-time configuration; `src/certs/` — TLS roots.

## Capability manifest generation

`tools/manifest-gen` compiles the firmware's action classes **natively on the host** to
emit the master capability catalog (consumed by seeding; provisioning is validate-only).
Requires a host C++ compiler — MinGW g++ on this machine. Entry point:
`tools/generate-manifests.mjs`.

## Native unit tests

`pio test -e native` runs Unity host tests over the **pure, Arduino-free** logic units, so a
build machine (or CI) can validate them without a board:

- `test/test_payload_validation` — `actions/commands/PayloadValidation.h`, the command-payload
  validator folded out of `BaseCommandAction`. This is the firmware side of the parity contract
  with `tools/device-sim/lib/command-models.js`; keep the two case matrices aligned.
- `test/test_topic_builder` — `services/TopicBuilder.h`, MQTT topic construction (the firmware
  analog of `tests/unit/telemetry.topic-parser.test.ts`).

New pure logic that both firmware and the host need (validators, topic/format helpers) goes in an
Arduino-free header (guarded by `#ifdef ARDUINO` only where it must touch Serial) so it can be
unit-tested here. `[env:native]` reuses the `tools/manifest-gen/include/Arduino.h` shim.

## Parity rule (mandatory)

Any change to device capabilities — new action, changed payload validation, new telemetry —
must update, in the same change:

1. `../tools/device-sim/lib/command-models.js` (mirrors `BaseCommandAction::validateActionPayload`)
2. `../tools/device-sim/PARITY.md` (the parity table)
3. Regenerated manifests if action metadata changed

The e2e suites test against the simulator; unmirrored firmware behavior is untested behavior.
