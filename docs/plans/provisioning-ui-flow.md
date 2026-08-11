# Provisioning UI Flow — Phase 2

Builds on the saved provisioning redesign plan. That plan's **Phase 1 (device-driven
provision) is already implemented**; this document covers only the open half — the
user-driven configure step and the UI that carries it.

Nothing here reopens a settled decision: upsert-by-MAC, single `POST /provision`, and
"provisioning yields a registered-but-idle device" all stand as decided.

## What already exists

| Piece                                                           | State                     |
| --------------------------------------------------------------- | ------------------------- |
| `GET /api/provisioning/provision-token`                         | built                     |
| `POST /api/provisioning/provision` (single call, upsert by MAC) | built                     |
| `POST /api/provisioning/refresh-token`                          | built                     |
| Device lands with **zero** `user_device_actions`                | built (as designed)       |
| Catalog auto-upsert from the device's declared capabilities     | built                     |
| `mgmt-device-register` BLE dialog                               | built, but ends too early |
| **User-facing configure step**                                  | **missing**               |
| `user_devices.status`                                           | **missing** — no column   |

## The actual problem

`provisionDevice()` deliberately creates no actions, so a freshly provisioned device is
inert by design. But the UI has no follow-through: the BLE dialog closes on
`PROVISIONING_COMPLETE`, and the device shows up in device-config under
_"No actions activated yet."_ (`device-config.component.html:211`). The user is left at a
dead end with a device that does nothing, and no prompt telling them what to do next.

Two smaller issues compound it:

- **The progress UI leaks internals.** `ProvisioningStep` has 24 members, including
  `JSON_PARSE_ERROR`, `MISSING_PARAMS`, and `UNDEFINED`. They're rendered raw into a
  `mat-list` as `STEP_NAME: message`. That's a debug log, not an onboarding screen.
- **"Registered" is inferred, not stored.** Without a `status` column, "needs
  configuration" is indistinguishable from "user deleted all their actions."

## Design — one wizard that ends at a working device

Provisioning and configuration become a single continuous flow. The guiding rule: **the
wizard is not done until the device does something.**

```
┌─ 1 Connect ──┐ ┌─ 2 Network ─┐ ┌─ 3 Register ─┐ ┌─ 4 Configure ─┐ ┌─ 5 Live ─┐
│ BLE picker   │ │ SSID + pass │ │ (automatic)  │ │ pick + assign │ │ confirm  │
│ pair         │ │ connect     │ │ token, MQTT  │ │ pins          │ │ working  │
└──────────────┘ └─────────────┘ └──────────────┘ └───────────────┘ └──────────┘
      user            user            spinner           user           spinner
```

### Step collapse: 24 enum members → 5 phases

Keep the full enum on the wire (it's a useful diagnostic), but map it to five phases for
display. Everything unmapped is a failure of its current phase.

| Phase       | Absorbs                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| 1 Connect   | `BLE_PAIRING_READY`, `BLE_PAIRING_COMPLETE`                                 |
| 2 Network   | `NETWORK_SCANNING/FOUND/CONNECTING/CONNECTED`, `WIFI_*`                     |
| 3 Register  | `REQUESTING_PROV_TOKEN` … `MQTT_CONNECTED_SUCCESS`, `PROVISIONING_COMPLETE` |
| 4 Configure | new — no BLE involvement, device is already on MQTT                         |
| 5 Live      | new — first telemetry/ack observed                                          |

Raw step names move behind a collapsed **"Show details"** disclosure, so the diagnostic
value survives without being the primary UI.

### Step 4 — Configure (the new work)

Source the capability list from the catalog rows the device just declared
(`device_capabilities` for its `(type, version)`), **not** from a hand-maintained list.

For each capability, one row:

```
┌────────────────────────────────────────────────────────┐
│ [✓]  Outlet 1                        Outlet ▾          │
│      Pin  ▾ GPIO 12                                    │
├────────────────────────────────────────────────────────┤
│ [ ]  Temperature                     Sensor            │
│      Pin  ▾ —            Interval ▾ 30s                │
└────────────────────────────────────────────────────────┘
```

- Checkbox = create a `user_device_action` or don't.
- Name prefills from the capability label; editable (this is the user's own label).
- Pin dropdown is constrained to the capability's `pins` slots — the catalog defines the
  mode, the user picks the GPIO number. Already-taken GPIOs are disabled, not just
  validated on submit.
- Interval only shows for capabilities with an `interval` behavior, floored at the
  catalog's `min_telemetry_interval_ms`.
- **Sensible default: everything checked**, pins prefilled where the capability declares
  exactly one legal slot. A user who just wants it to work presses Next once.

Submit creates the rows and pushes config to the device over its existing MQTT session
(the device is already connected and idle from step 3).

### Step 5 — Live

Wait for the first ack/telemetry, then show "working". This is what makes the wizard
honest — it closes on evidence, not on an HTTP 200.

If nothing arrives within ~15s: keep the device configured, show _"Configured, but the
device hasn't reported yet"_ with a **Retry** that re-pushes config. Never silently
succeed.

### Sealed devices skip step 4

A sealed type's configuration is the admin template, not a user choice — the user has no
pins to assign. The wizard goes `3 → 5` and step 4 renders as a read-only summary of
what the template activated. This matters immediately: `MULTI_SOCKET_8_CH` is sealed.

## Schema change

Add to `UserDevice`:

```prisma
status String @default("active") @db.VarChar(32)
// provisioning → registered, no actions yet, wizard not finished
// active       → configured and reporting
```

- Needs a real migration (no `db push` drift) **and** a `prisma/SCHEMA.md` update in the
  same change.
- Default `active` so every existing row keeps its current meaning; only new
  provisioning writes `provisioning`.
- Set to `provisioning` in `provisionDevice()`, flipped to `active` on the step-5
  confirmation.

This is what makes an abandoned wizard recoverable: the device list can show a
**"Finish setup"** affordance on `status = 'provisioning'` rows and re-enter the wizard
at step 4. Today that state is unrepresentable.

## Resume + re-provision

- **Wizard abandoned mid-way** → row exists with `status='provisioning'`, device online
  and idle. Device list shows "Finish setup" → re-enter at step 4.
- **Re-provision of a configured device** (firmware update, factory reset) → upsert by
  MAC keeps the row and its actions; status stays `active` and the wizard is skipped
  entirely. This is already the backend behavior; the UI just has to not fight it.

## Build order

1. Schema: `status` column + migration + SCHEMA.md.
2. `provisionDevice()` writes `status='provisioning'`.
3. Config-apply endpoint: create actions + push MQTT config + flip to `active`.
4. Wizard shell: 5 phases, enum→phase mapping, details disclosure.
5. Step 4 UI against the catalog capabilities.
6. Step 5 confirmation + timeout/retry.
7. "Finish setup" entry point in the device list.

Steps 1–3 are independently useful and shippable before any UI lands.

## Out of scope

- BLE transport itself (Web Bluetooth, characteristic protocol) — unchanged.
- Wi-Fi credential handling — unchanged.
- The catalog/manifest pipeline — unchanged; this consumes it.
