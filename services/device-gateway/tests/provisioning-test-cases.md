# Provisioning Integration Test Cases

## Overview

Integration tests for the device-gateway provisioning flow. Tests cover the full
HTTP layer — auth middleware, route handlers, service logic, and DB interactions —
using a mocked Prisma client and mocked Redis.

**Service under test:** `services/device-gateway`
**Test runner:** Jest + Supertest

---

## Flow Summary

```
Mobile App
  │  GET /api/provisioning/provision-token (backend API)
  ▼
BLE write → ESP32 device
  │  POST /api/provision/register  (device-gateway) ← open
  ▼
ESP32 tests MQTT connection with temp token
  │  POST /api/provision/complete  (device-gateway) ← provisioning JWT
  ▼
Device stores permanent token & restarts
  │  POST /api/provision/token/refresh (device-gateway) ← device_usage_refresh JWT
```

---

## Test Suites

### Suite 1 — POST /api/provision/register

| ID       | Scenario                                              | Auth            | Expected |
|----------|-------------------------------------------------------|-----------------|----------|
| TC-P-01  | Missing `mac_id` field                                | none            | 400      |
| TC-P-02  | Missing `model_key` / `deviceType` field              | none            | 400      |
| TC-P-03  | Missing `version` field                               | none            | 400      |
| TC-P-04  | No user_id and no provisioning token in header/body   | none            | 401      |
| TC-P-05  | Invalid/malformed bearer token (not a JWT)            | invalid bearer  | 401      |
| TC-P-06  | Bearer token has wrong purpose (device_usage)         | device_usage    | 401      |
| TC-P-07  | New device — user_id in body, unbound placeholder exists | none          | 200 ✓   |
| TC-P-08  | New device — user_id extracted from provisioning bearer token | prov JWT  | 200 ✓   |
| TC-P-09  | New device — no unbound placeholder; auto-creates device slot | user_id body | 200 ✓ |
| TC-P-10  | v1 field names: `macAddress` + `deviceType` normalised | user_id body  | 200 ✓   |
| TC-P-11  | Re-provisioning — mac_id already bound; no user_id needed | none        | 200 ✓   |

**Success response shape (200):**
```json
{
  "mqttToken":           "<provisioning JWT>",
  "registrationId":      "42",
  "finalizeCallbackUrl": "http://localhost:3004/api/provision/complete",
  "validateCACert":      false
}
```

**Token assertions for 200 cases:**
- `mqttToken` is a valid JWT with `purpose = device_provisioning`
- `decoded.id` equals the resolved `user_id`
- `decoded.deviceId` equals the found/created device id
- `decoded.mac_id` equals the requested `mac_id`

---

### Suite 2 — POST /api/provision/complete

| ID       | Scenario                                              | Auth              | Expected |
|----------|-------------------------------------------------------|-------------------|----------|
| TC-C-01  | No Authorization header                               | none              | 401      |
| TC-C-02  | Wrong token purpose (device_usage instead of provisioning) | device_usage  | 403      |
| TC-C-03  | Expired provisioning token                            | expired prov JWT  | 403      |
| TC-C-04  | Happy path — binds mac_id, creates actions, issues device_usage JWT | prov JWT | 200 ✓ |
| TC-C-05  | Device has no action defs — returns empty actions array | prov JWT        | 200 ✓   |
| TC-C-06  | Idempotent — called twice; skipDuplicates prevents duplicate actions | prov JWT | 200 ✓ |

**Success response shape (200):**
```json
{
  "deviceId":               42,
  "mqttToken":              "<device_usage JWT>",
  "refreshToken":           "<device_usage_refresh JWT>",
  "refreshTokenCallbackUrl":"http://localhost:3004/api/provision/token/refresh",
  "deviceConfigUrl":        "http://localhost:3004/api/config",
  "validateCACert":         false,
  "wsStreamUrl":            "",
  "cameraHttpUrl":          "http://localhost:3004/api/camera/frame",
  "actions": [
    {
      "action_key":            "led",
      "mqtt_type":             "cmnd",
      "mqtt_name":             "POWER",
      "capability":            "switch",
      "pins":                  [],
      "telemetry_interval_ms": null
    }
  ]
}
```

**Token assertions for 200:**
- `mqttToken` → valid, purpose = `device_usage`
- `refreshToken` → valid, purpose = `device_usage_refresh`
- Both tokens carry `{ id: userId, deviceId, mac_id }`

**Side-effect assertions:**
- `db.userDevice.update` called with `{ mac_id, online: false }`
- `db.userAction.createMany` called with `skipDuplicates: true`
- Redis `del` called for `device_map:{mac_id}` and `action_map:{deviceId}:*`

---

### Suite 3 — POST /api/provision/token/refresh

| ID       | Scenario                                              | Auth                    | Expected |
|----------|-------------------------------------------------------|-------------------------|----------|
| TC-R-01  | No Authorization header                               | none                    | 401      |
| TC-R-02  | Wrong purpose (provisioning token)                    | prov JWT                | 403      |
| TC-R-03  | Wrong purpose (device_usage — not the refresh variant) | device_usage JWT      | 403      |
| TC-R-04  | Happy path — returns new device_usage token           | device_usage_refresh JWT | 200 ✓  |

**Success response shape (200):**
```json
{ "token": "<new device_usage JWT>" }
```

**Token assertions:**
- New `token` is a valid JWT with `purpose = device_usage`
- Carries same `{ id, deviceId, mac_id }` as the refresh token

---

### Suite 4 — End-to-End Provisioning Flow

| ID       | Scenario                                              | Expected               |
|----------|-------------------------------------------------------|------------------------|
| TC-E-01  | Full flow: register → complete → token/refresh        | All 3 steps succeed ✓ |
| TC-E-02  | Re-provision existing device (register → complete again) | New permanent token ✓ |

**TC-E-01 step-by-step assertions:**
1. `POST /register` (user_id in body) → 200, mqttToken (provisioning JWT)
2. `POST /complete` (mqttToken as bearer) → 200, mqttToken (device_usage JWT), refreshToken
3. `POST /token/refresh` (refreshToken as bearer) → 200, new token (device_usage JWT)
4. Final token has same payload as step-2 token

---

## Mock Strategy

| Dependency              | Mock approach                     |
|-------------------------|-----------------------------------|
| `@lattice/prisma-client` | `moduleNameMapper` → manual mock with `jest.fn()` delegates |
| `ioredis`               | `moduleNameMapper` → mock class, all methods return resolved promises |
| `@lattice/logger`       | `moduleNameMapper` → no-op logger |
| `@lattice/otel`         | `moduleNameMapper` → no-op        |
| `@lattice/queue`        | `moduleNameMapper` → no-op        |
| `mqtt` (mqtt.service)   | Not imported by provisioning routes — no mock needed |

Mocks are reset between tests via `jest.config.ts → resetMocks: true`.
