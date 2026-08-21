# Third-Party Device Adoption — flashing Lattice onto off-the-shelf ESP boards

Design for bringing store-bought devices (Sonoff / Shelly / Tuya-class) onto Lattice
firmware, so that afterwards they are ordinary Lattice devices served by the existing OTA
path.

**Status:** design only — nothing here is implemented.

## The problem

Lattice OTA reaches a device that is _already ours_. `applyUpdate()` stages
`pending_firmware_version`, then publishes `RK.OTA_DISPATCH`
(`action-migration.service.ts:206`); mqtt-service turns that into a **retained**
`ota/updates/<deviceType>` message; the device — already subscribed, already holding a
`device_usage` JWT from provisioning — downloads the binary and reboots
(`OtaService.h:51`).

A store-bought box subscribes to none of that and holds no token. So the first flash can
never be a Lattice OTA. **Adoption is a separate, one-shot subsystem that ends where the
existing OTA path begins.**

## What already exists

| Piece                                                         | State                                 |
| ------------------------------------------------------------- | ------------------------------------- |
| Per-device OTA staging + confirm (`pending_firmware_version`) | built                                 |
| Retained `ota/updates/<deviceType>` dispatch                  | built (broadcast, by type)            |
| Device-JWT-authenticated `/download` in ota-manager           | built                                 |
| Provisioning **upsert by MAC**                                | built — this is the join key we reuse |
| Sealed device types (`is_sealed`, `SealedTemplate`)           | built — this is how we model a Shelly |
| Anything that can reach a LAN-only vendor HTTP endpoint       | **missing**                           |
| Any record of a device that is not yet a `user_device`        | **missing**                           |

## Three facts that shape everything

**1. The control plane cannot reach the devices.** Lattice runs in k3s on OCI. A Shelly is
`http://192.168.1.50` behind the user's NAT. No amount of queue design fixes this — the
conversion step has to execute _on the LAN_. This is the single largest design consequence:
adoption needs a LAN-resident agent.

**2. The vendor updater cannot authenticate to ota-manager.** It will not present a device
JWT and typically will not do TLS against our pinned CA. So the **agent** pulls the binary
(authenticated, over TLS) and re-serves it to the device over plain HTTP on the local
subnet. The device never talks to the platform.

**3. Conversion is one-shot and per-device — it must not reuse the OTA channel.**
`RK.OTA_DISPATCH` is retained and addressed _by device type_: publishing it hits every
device of that type, forever, including devices that reconnect later. That is precisely the
failure mode documented in `ota-incoming.consumer.ts:26-36` (the stranded prod device 6).
Adoption is addressed to _one IP on one LAN_, so it gets its own non-retained routing keys.

## Design

```
backoffice "Adopt a device"
        │
        ▼
  device-gateway ──► q.adoption.dispatch ──►  [ LAN ] lattice-adopter
        ▲                                        │  1. probe + fingerprint
        │                                        │  2. feasibility gate
        │                                        │  3. GET /download (agent JWT, TLS)
        │                                        │  4. serve http://<agent>:<port>/fw.bin
        └──────────── q.adoption.result ◄────────┘  5. POST the vendor's OTA endpoint
                                                    │
                                        device reboots into Lattice firmware
                                                    │
                                    normal BLE/WiFi provisioning, upsert by MAC
                                                    │
                                              a UserDevice row
```

From that last step onward there is nothing special about the device — the existing OTA
path owns it.

### 1. `lattice-adopter` — a LAN-resident agent

A small Node container the user runs on their own network (Pi, NAS, dev box). It:

- **discovers** candidates — mDNS (`_shelly._tcp`, `_http._tcp`, `_esphomelib._tcp`) plus an
  optional subnet sweep of known vendor ports;
- **fingerprints** each hit through its vendor driver;
- **reports** candidates upward and **executes** conversion jobs.

Transport is **outbound MQTT to the existing EMQX**, with its own `mqtt_user` credential —
the same trust shape devices already use, and it needs no inbound firewall rule. The agent
is the only new network-privileged component, so it stays deliberately small: discovery,
drivers, a temp HTTP server, and job reporting. No business logic.

### 2. Vendor drivers

```ts
interface VendorIdentity {
  vendor: 'shelly' | 'tasmota' | 'sonoff-diy' | 'esphome';
  model: string; // "SNSW-001X16EU"
  chip: string; // "ESP32" | "ESP8266" | "ESP32-C3"
  flashBytes: number;
  mac: string; // the join key to the eventual UserDevice
  vendorFwVersion: string;
}

interface AdoptionDriver {
  readonly vendor: string;
  probe(host: string): Promise<VendorIdentity | null>;
  flash(host: string, binUrl: string, id: VendorIdentity): Promise<void>;
}
```

| Driver          | Probe                       | Flash                                          |
| --------------- | --------------------------- | ---------------------------------------------- |
| `shelly-gen1`   | `GET /shelly`               | `GET /ota?url=<binUrl>`                        |
| `shelly-gen2`   | `GET /shelly` (RPC-capable) | **needs validation** — see risk 1              |
| `tasmota`       | `GET /cm?cmnd=Status%200`   | multipart upload to `/u2`                      |
| `sonoff-diy`    | `POST /zeroconf/info`       | `/zeroconf/ota_unlock` → `/zeroconf/ota_flash` |
| `esphome`       | mDNS + `GET /`              | multipart upload to `/update`                  |
| `manual-serial` | —                           | emits wiring instructions + the correct `.bin` |

`manual-serial` is a first-class driver, not a fallback apology: for many models serial is
the _only_ honest path, and the platform's job is then to hand the user the right binary and
the right pinout rather than pretend to automate it.

### 3. The feasibility gate

Runs at probe time, before a candidate is ever offered in the UI. Chip family decides:

| Chip                    | Verdict                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| ESP32 WROOM/WROVER, 4MB | supported — `esp32_wroom32e` is this silicon                                             |
| ESP32-S3                | supported                                                                                |
| ESP32-C3 / C6           | needs a new PlatformIO env (RISC-V); no env exists today                                 |
| **ESP8266 / ESP8285**   | **rejected** — no BLE radio, and 1MB flash cannot hold the app, let alone dual OTA slots |

The ESP8266 rejection is not a limit worth engineering around; it is the correct answer for
a large fraction of older Sonoff/Tuya hardware, and the UI should say so plainly with the
reason attached to the candidate.

### 4. Third-party boards are _sealed device types_

The pin map of a Shelly Plus 1 is fixed by its factory soldering. That is exactly what
`is_sealed` already means in this schema: a board built for one application, whose pins and
actions come from an admin-composed `SealedTemplate` rather than user configuration.

So each supported model becomes a sealed device type — `SHELLY_PLUS_1` — with:

- a PlatformIO env cloned from the matching hardware base, carrying `-D SEALED`, the model's
  `DEVICE_TYPE_STR`, and its pin map as build flags;
- regenerated manifests + a seeded catalog row (`tools/manifest-gen`);
- a firmware directory in the OTA pipeline via `esp32-ota-ci.yml`.

**No new catalog concept is required.** This is the part of the design that costs the least
and buys the most: adoption produces devices the rest of the platform already understands.

### 5. Data model

Two tables. The critical property is that a candidate is _not_ a `user_device` — it has no
owner-configured actions and may never become one.

```prisma
model AdoptionAgent {
  id         Int      @id @default(autoincrement())
  user_id    Int
  name       String   @db.VarChar(255)
  last_seen  DateTime?
  // + relation to User
}

model AdoptionJob {
  id              Int      @id @default(autoincrement())
  agent_id        Int
  mac             String   @db.VarChar(255)   // join key to the future UserDevice
  ip              String   @db.VarChar(64)
  vendor          String   @db.VarChar(64)
  model           String   @db.VarChar(128)
  chip            String   @db.VarChar(32)
  flash_bytes     Int
  feasibility     String   @db.VarChar(32)    // supported | needs_env | rejected | manual_only
  reason          String?                     // why rejected — shown in UI
  target_type     String?  @db.VarChar(255)   // DEVICE_TYPE_STR chosen for conversion
  status          String   @db.VarChar(32)    // discovered | dispatched | flashing | flashed | failed | provisioned
  error           String?
  // + timestamps
}
```

`status` reaches `provisioned` when provisioning upserts a `user_device` whose MAC matches an
adoption job — closing the loop without any new coupling between the two subsystems.

### 6. Queue contract

Three new keys in `packages/queue/src/index.ts`, all **non-retained and per-target**:

- `RK.ADOPTION_DISCOVERED` — agent → platform, a fingerprinted candidate
- `RK.ADOPTION_DISPATCH` — platform → agent, "convert this MAC to this device type"
- `RK.ADOPTION_RESULT` — agent → platform, progress and terminal outcome

They deliberately do not touch `OTA_INCOMING` / `OTA_DISPATCH`.

### 7. ota-manager change

One addition: accept an agent token. `requireDeviceToken` currently demands
`purpose === 'device_usage'` (`index.js:47`); adoption adds `adoption_agent` as an accepted
purpose on the `/download` path. The static serving, the rate limiter, and the metadata route
are unchanged.

## Branch B — devices that can never run Lattice firmware

Everything above assumes the target is an Espressif chip. For the single most common real
device — a cheap Tuya/SmartLife plug off AliExpress — that assumption usually fails, and it
fails on silicon rather than on protocol:

| Module marking         | Chip              | Can run Lattice firmware?                               |
| ---------------------- | ----------------- | ------------------------------------------------------- |
| `TYWE3S`, `TYWE1S`     | ESP8285           | No — no BLE, 1MB flash                                  |
| `WB3S`, `CB3S`, `CB2S` | Beken BK7231T/N   | **No — not an Espressif chip**                          |
| `WR3`                  | Realtek RTL8710BN | **No — not an Espressif chip**                          |
| newer ESP32-C3 modules | ESP32-C3          | Only with a new env; 2MB parts can't hold two OTA slots |

Delivery is not the obstacle here. The Tuya "fake cloud" technique
(`tuya-convert`, superseded by `tuya-cloudcutter`) reliably pushes arbitrary firmware to
these devices without opening the case. What it pushes cannot be _our_ firmware, because
ours is Arduino-ESP32.

**Non-destructive triage:** an Espressif MAC OUI (`24:0A:C4`, `30:AE:A4`, `84:CC:A8`,
`A4:CF:12`, `7C:9E:BD`) means an ESP chip and Branch A may apply. Anything else means
Branch B. Confirm by reading the module marking inside the case.

### The Branch B design: a protocol adapter, not a firmware port

For these devices the goal inverts — instead of making the device run our firmware, we make
it speak our protocol:

1. Convert to **OpenBeken** (BK7231) or **Tasmota** (ESP8266/ESP32) via cloudcutter. Both are
   native MQTT clients.
2. Issue the device an `mqtt_user` credential against the existing EMQX.
3. A **foreign-device adapter** maps between the third-party topic/payload shape and
   Lattice's `<base>/<mac>/command/<action>` + ack contract, and registers a
   `user_device` whose capabilities are declared by the adapter rather than by a firmware
   manifest.

What is given up: BLE provisioning, the generated capability manifest, and Lattice OTA for
that device — it keeps updating through its own firmware's channel. What is gained is the
thing that actually motivates adoption: the device leaves the vendor cloud.

This is a **smaller build than Branch A** and covers strictly more hardware. If the real
goal is "get my existing devices off SmartLife", Branch B should be built first, and Phase 0
of Branch A should not start until a device is confirmed to be Espressif-based.

## Deliberately out of scope

- **Automatic conversion.** Always user-initiated, one device at a time. Flashing someone's
  hardware is not something a reconcile loop should ever decide to do.
- **Cloud→LAN inbound connectivity** in any form.
- **Reimplementing vendor cloud protocols.** Branch B converts the device to open firmware
  first; Lattice never speaks Tuya's protocol itself.

## Risks and open questions

1. **Do Gen2+ Shelly devices accept unsigned third-party images?** Gen1 (ESP8266)
   `/ota?url=` famously does; the ESP32-based Gen2 line is more locked down and may validate
   the image before applying it. This is the top unknown and it decides whether the HTTP path
   covers the most interesting hardware or only the un-convertible ESP8266 generation.
   **Phase 0 exists to answer this on one real device.**
2. **HTTP conversion is one-way.** The vendor endpoints flash but cannot dump flash, so there
   is no backup and no rollback. Only the serial path can `read_flash` the original image
   first. The UI must say this before the user commits.
3. **Recovery from a bad flash is serial**, i.e. opening the case. A wrong pin map produces a
   device that boots and provisions but controls nothing — recoverable by OTA. A wrong
   _partition table_ produces a brick — not recoverable over the air.
4. **Mains safety.** Most of these are line-powered relays. Any serial instructions the
   platform emits must lead with "disconnect mains first".
5. **Vendor size caps.** Some updaters cap the accepted image size, which may force an
   intermediate minimal image before the full Lattice binary.

## Is this worth building at all?

An honest fork, because the answer is not obviously yes.

**Against.** An ESP32 dev board costs a few dollars and runs the real firmware with every
feature already built. Converting a 1MB ESP8285 yields a permanently second-class device: no
BLE provisioning, no generated manifest, no Lattice OTA. And Branch B is not free — it needs
a device whose capabilities are declared by _config_ rather than derived from a firmware
manifest, which is a genuinely new concept in a codebase that currently has exactly one way
to know what a device can do. If the fleet is meant to be Lattice-native, buy ESP32 hardware
and skip this entirely.

**For.** The individual device is not the asset; the _class_ is. One adapter speaking
Tasmota's MQTT dialect also reaches ESPHome, OpenBeken, and every Tasmota-flashable device
ever made — most of the consumer IoT market. That is the difference between a platform that
runs its author's hardware and one that runs a house. Some devices also cannot practically
be swapped (a switch behind a wall plate, a plug already paid for).

**Decision rule.** Do not commit to the adapter; commit to one experiment. Tasmota's
`FullTopic`/`Prefix` settings and rules can publish arbitrary JSON to arbitrary topics, so a
large part of the mapping may live in _Tasmota config_ rather than Lattice code. Flash one
device, configure its topics as close to `<base>/<mac>/command/<action>` as Tasmota allows,
and measure the gap. A small gap means Branch B is a thin shim and clearly worth it; a large
gap kills the idea on evidence rather than on a guess. Either way the cost is one evening.

## Target inventory

Devices this plan is actually meant to serve. Keep this table updated as hardware is
triaged — it is what decides which branch gets built first.

| Device                         | MAC                 | OUI owner           | Chip family | Branch            |
| ------------------------------ | ------------------- | ------------------- | ----------- | ----------------- |
| Smart plug (SmartLife/Tuya)    | `dc:4f:22:b6:0d:57` | Espressif Inc.      | **unknown** | pending           |
| **Sonoff Mini V1.2** (eWeLink) | `c8:2b:96:dc:af:8f` | Espressif Inc.      | **ESP8285** | **B — confirmed** |
| Unidentified BLE `TY` beacon   | `f8:17:2d:f5:27:e7` | **Tuya Smart Inc.** | **unknown** | likely B          |

**The switch is identified by hardware inspection**: a Sonoff Mini, PCB marked `Mini V1.2
2020.01.15`, carrying an ESP8285 (ESP8266-family, 1MB integrated flash, **no Bluetooth
radio**). It is a permanent Branch B device — Lattice firmware is Arduino-ESP32 on Xtensa
LX32/RISC-V and cannot be ported to an LX106 with 1MB of flash. Its board exposes the
`GND`/`OTA` DIY jumper pads, so it is also the _easiest_ Branch B conversion available.

Note what this proves about triage: the Espressif OUI was correct and still misleading —
Espressif silicon, wrong family. Only the module inspection was decisive.

The first two OUIs (`DC:4F:22`, `C8:2B:96`) are registered MA-L blocks belonging to
Espressif Inc., verified against the IEEE registry. That rules out the Beken/Realtek dead
end for both — **neither is a Branch B write-off on silicon-vendor grounds.**

The third row is a device found during triage, advertising BLE under the name `TY` at close
range. Its OUI belongs to **Tuya Smart Inc. rather than Espressif**, which is the signature
of Tuya's own module silicon (Beken/Realtek) — the Branch B profile. It has not yet been
matched to a physical device. Its existence is the concrete evidence that this fleet spans
both branches, and that neither branch can be dropped from the design.

It does **not** establish which Espressif family they are. Espressif reuses OUI blocks across
the ESP8266 and ESP32 lines, so the MAC cannot discriminate ESP8285 (Branch B: no BLE, 1MB
flash) from ESP32 (Branch A). Two ways to settle it:

- **BLE scan (non-invasive, asymmetric).** ESP8266 has no Bluetooth radio at all. If the
  device advertises BLE, it is ESP32-family and Branch A applies. Silence is _not_ proof of
  ESP8266 — the vendor firmware may simply not advertise.
- **Power-cycle diff (addressing-agnostic).** The `base+2` correlation fails when vendor
  firmware assigns a BLE address from the module maker's own OUI instead of the efuse base —
  observed in practice on this fleet. Snapshot the air with the device powered, cut power,
  scan again: whatever disappeared at strong RSSI is the device, whatever its addressing.
- **Module marking (definitive).** Open the case and read the module: `TYWE3S`/`TYWE1S` =
  ESP8285 → Branch B; an ESP32 module or bare ESP32-C3 → Branch A.

Because both devices are Espressif, **Branch A is live for this inventory** and Phase 0 is
worth running as soon as one device is confirmed ESP32-family.

## Phasing

**Phase 0a — triage the actual hardware.** For each device in the inventory above: BLE scan
first, module marking if that is inconclusive. Record the chip family in the table. This
decides which branch gets built.

> **Empirical note.** Non-invasive triage was attempted on this fleet and did **not**
> resolve the chip family. Two BLE scans produced no address correlation; the one Tuya
> advertiser seen (`TY`, `f8:17:2d:…`) did not reappear on a second pass and belongs to a
> different OUI than either target. The WiFi-SoftAP route (reading the pairing AP's BSSID,
> which equals base+1) is blocked on Windows 11 unless Location services are enabled and
> the shell is elevated. Budget for **opening the case** — it is two minutes and definitive,
> and on this fleet it is the cheaper path, not the fallback.

**Phase 0 — prove the risky bit** (Branch A only). A throwaway `tools/device-adopter` script: probe one
host, serve the binary, drive the vendor endpoint. No platform changes, no DB, no queue.
Success = one real device converts, boots Lattice firmware, provisions by MAC, appears in
the backoffice, and then takes a normal Lattice OTA. That single chain is the entire risk of
this design; everything after it is plumbing.

**Phase 1 — make the target real.** Sealed device type for that model: PlatformIO env with
its pin map, manifest regen, catalog seed, CI firmware directory.

**Phase 2 — productize the agent.** Promote the script to `lattice-adopter`: MQTT transport,
discovery, driver interface, the two tables, the three routing keys, the ota-manager token
purpose.

**Phase 3 — the wizard.** Backoffice adopt flow: scan → candidates with feasibility badges
and reasons → pick target type → convert → live progress → hand off to provisioning.

Phase 0 is worth doing before any of the rest is designed further, because risk 1 can
invalidate the HTTP half of this document.
