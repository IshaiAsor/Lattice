---
name: run-esp32code
description: Build, flash, and monitor the ESP32 smart home firmware. Use when asked to build, compile, run, upload, flash, or test the ESP32 firmware, or to check if the firmware compiles successfully.
---

ESP32 firmware for the IoT smart home device (smart outlet + temperature sensor + BLE provisioning). Built with PlatformIO targeting ESP32-S3. This is embedded firmware — "running" it means compiling to a `.bin` and flashing to physical hardware. The driver (`smoke.ps1`) handles the build + verify step without hardware.

Paths in this file are relative to `ESP32Code/`.

## Prerequisites

PlatformIO is already installed at `C:\Users\ishai\.platformio\penv\Scripts\pio.exe`. On a fresh machine:

```
pip install platformio
```

Library dependencies are resolved automatically by PlatformIO on first build (cached in `.pio/libdeps/`).

## Build (agent path)

Run the smoke script to compile and verify the firmware binary:

```powershell
powershell -File .claude\skills\run-esp32code\smoke.ps1
```

Optional: specify a different environment:

```powershell
powershell -File .claude\skills\run-esp32code\smoke.ps1 -Env esp32s3_mini-prod
```

On success the script prints the firmware size and exits 0:

```
OK  firmware.bin  1782.3 KB  (.pio\build\esp32s3_mini-test\firmware.bin)
```

First run downloads and compiles the ESP32 Arduino framework (~40s). Subsequent runs are incremental (~8s on a warm cache).

## Environments

| Environment | Board | Use |
|---|---|---|
| `esp32s3_mini-test` | ESP32-S3 DevKitC-1 | dev/test (default) |
| `esp32s3_mini-prod` | ESP32-S3 DevKitC-1 | production |
| `4d_systems_esp32s3_gen4_r8n16-test` | 4D Systems Gen4 | dev/test |
| `4d_systems_esp32s3_gen4_r8n16-prod` | 4D Systems Gen4 | production |

## Build (human path)

```powershell
$env:PATH = "C:\Users\ishai\.platformio\penv\Scripts;" + $env:PATH
pio run -e esp32s3_mini-test
```

## Flash to hardware (requires physical ESP32 connected via USB)

```powershell
$env:PATH = "C:\Users\ishai\.platformio\penv\Scripts;" + $env:PATH
pio run -e esp32s3_mini-test --target upload
```

## Monitor serial output (requires connected device)

```powershell
$env:PATH = "C:\Users\ishai\.platformio\penv\Scripts;" + $env:PATH
pio device monitor   # 115200 baud
```

## Key source files

- `src/SmartHome.cpp` — main `setup()` / `loop()`, WiFi/MQTT/BLE init
- `src/config/settings.h` — device type, topic templates, pin constants, timeouts
- `src/actions/DeviceActions.h` — declares which actions and sensors are wired up (edit here to add a new device)
- `src/actions/commands/OutletCommandAction.h` — outlet on/off logic
- `src/actions/telemtries/TemperatureAction.h` — temperature sensor reporting
- `src/services/mqtt.h` — MQTT connection and topic subscription
- `src/services/ProvisioningBleService.h` — BLE provisioning flow

## Gotchas

- **`pio` not in PATH on Windows** — the installer puts it in `C:\Users\ishai\.platformio\penv\Scripts\`. Either add that to PATH or call `pio.exe` with a full path. The smoke script handles this automatically.
- **Flash size near limit** — Flash usage is ~92.8% (1.82 MB / 1.97 MB). Adding large new libraries may push over. Check the size report after building; if it overflows, check `platformio.ini` for the `board_build.partitions` setting.
- **`4d_systems_esp32s3_gen4_r8n16` monitor port is hardcoded** — `monitor_port = COM3` in `platformio.ini` for the prod environment. If the device isn't on COM3, override with `pio device monitor --port COMx`.
- **Factory reset** — holding GPIO0 (BOOT button) during power-on triggers a factory reset (clears WiFi, MQTT credentials, NVS). This is intentional; don't hold the button while testing flash.
- **BLE provisioning** — on first boot with no saved WiFi credentials, the device enters BLE provisioning mode and advertises as `SmartOutlet_Setup`. The backend's provisioning flow must be active to complete setup.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pio: command not found` | `$env:PATH = "C:\Users\ishai\.platformio\penv\Scripts;" + $env:PATH` |
| `Error: Missing "partitions" option` | Ensure `ota_partitions.csv` exists in `ESP32Code/` root |
| Build succeeds but upload fails with `No serial port found` | Device not connected, wrong COM port, or driver not installed |
| Flash size overflow | Reduce library footprint or switch to a 16 MB partition table |
