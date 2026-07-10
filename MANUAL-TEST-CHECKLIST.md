# Manual Test Checklist — uncommitted changes (2026-07-10)

Covers everything currently in the working tree: **F15 notifications + auth flows** (built this
session) and the **pre-existing uncommitted work** (heartbeat/RSSI, fault readings, behavior
configs, ESP32 firmware refactor).

## Stack

Already up and verified. Bring it back with:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d
```

| Thing                                 | URL                    |
| ------------------------------------- | ---------------------- |
| App (backoffice)                      | http://localhost:4200  |
| Mailpit — catches verify/reset emails | http://localhost:8025  |
| RabbitMQ management                   | http://localhost:15672 |
| Adminer (DB)                          | http://localhost:8080  |

Login: `admin` / the `OWNER_PASSWORD` from `.env`.

### Gotchas

- **Auth rate limiter** is per-IP (150 req / 15 min). If you hammer login/register you'll start
  getting `403 Forbidden` on _every_ authed call. Reset it with:
  `docker compose -f compose.yaml -f compose.dev.yaml restart api`
- **device-sim re-provisions on restart**, creating new device rows (ids shift). Harmless.
- Email/push in dev: **email → Mailpit**; **push (VAPID) is not configured** → no-op adapter.

---

## A. Notifications (F15) — new this session

### A1. Inbox + unread badge

- [ ] Log in → a **bell** appears in the sidebar with an unread badge (should be non-zero; the
      seeded stack already has `device_offline` + `rule_fired` notifications).
- [ ] Click the bell → **Inbox** lists notifications, unread ones have a dot + tinted background.
- [ ] Click a row → it marks read (dot clears, badge decrements).
- [ ] Click **Mark all read** → badge goes to 0.
- [ ] Collapse the sidebar → badge still visible on the bell icon.
- [ ] On mobile width → Notifications reachable from the **profile menu** (with badge).

### A2. Live delivery (socket)

- [ ] Keep the app open. In a terminal, publish a notification to yourself:
  ```bash
  # from repo root
  source .env
  export RABBITMQ_URL="amqp://${RABBITMQ_USER:-guest}:${RABBITMQ_PASSWORD:-guest}@localhost:5672"
  node -e "const {connect,publish,RK}=require('@lattice/queue');(async()=>{const ch=await connect(process.env.RABBITMQ_URL);
  publish(ch,RK.NOTIFICATION_SEND,{userId:'1',eventType:'rule_fired',data:{ruleName:'LIVE-TEST'},dedupeKey:'live-'+Date.now()});
  setTimeout(()=>process.exit(0),800);})();"
  ```
- [ ] The badge increments **without a refresh** and the row appears at the top of the Inbox.

### A3. Preferences matrix

- [ ] Bell → **Preferences** tab → grid of events × channels (In-app / Email / Push / SMS).
- [ ] **In-app + Emergency** toggle is disabled with an "Always on" tooltip (cannot be silenced).
- [ ] Toggle a cell off (e.g. Email × Firmware updates) → reload the page → it stayed off.
- [ ] Turn **In-app** off for `rule_fired`, re-run the A2 publish → **no** inbox row appears.
      (Turn it back on afterwards.)

### A4. Defaults for a brand-new user

- [ ] Register + verify a fresh account (see B1) → its Preferences show: in-app on everywhere,
      email on **only** for Emergency, push/sms off.

### A5. Dedupe

- [ ] Run the A2 publish twice **with the same `dedupeKey`** → only **one** notification arrives
      (5-minute dedupe window).

---

## B. Auth flows — new this session

> All emails land in **Mailpit → http://localhost:8025**

### B1. Register → verify → logged in

- [ ] `/register` a new account → you land on a **"Check your inbox"** screen (you are _not_
      logged in, no token issued).
- [ ] Mailpit shows **"Verify your email address"** with a link like
      `http://localhost:4200/#/verify-email?token=…`
- [ ] Click the link → you land on the **dashboard, already signed in**.
- [ ] Repeat and instead click **Resend email** on the inbox screen → a second email arrives.

### B2. Login gate for unverified accounts

- [ ] Register but **don't** verify → try to sign in → error _"Please verify your email address"_
      plus a **"Resend verification email"** button.
- [ ] Click resend → new email in Mailpit; verify via that link → sign-in now works.
- [ ] Sign in with **Google** → **no** gate (Google accounts are auto-verified).

### B3. Password reset

- [ ] Login page → **"Forgot password?"** → enter your email → "Check your inbox" screen.
- [ ] Enter a **nonexistent** email → still shows success (no account-existence leak).
- [ ] Mailpit → **"Reset your password"** → click link → set a new password (min 8 chars).
- [ ] Mismatched confirm / <8 chars → inline validation errors.
- [ ] On success → redirected to login → sign in with the **new** password.
- [ ] Reuse the same reset link → **"invalid or expired"** (single-use).

### B4. No regressions

- [ ] The seeded `admin` and any pre-existing users still log in (migration backfilled
      `email_verified = true`). ✅ already confirmed.

---

## C. Device heartbeat + RSSI — pre-existing uncommitted

- [ ] Devices page → an online device shows **RSSI** (should read `-55` from the simulator).
- [ ] A device with **no telemetry activity** still shows **online** (heartbeat keeps it alive).
- [ ] Stop a device (`docker compose -f compose.yaml -f compose.dev.yaml stop device-sim`) →
      after the TTL it flips **offline** in the UI.
- [ ] That offline transition fires a **`device_offline` notification** in your inbox
      (ties C into A). ✅ already confirmed working.
- [ ] Restart device-sim → devices come back online (note: new device ids).

---

## D. Telemetry fault / error readings — pre-existing uncommitted

- [ ] Have a device emit an **error/fault reading** → it is **persisted**, not silently dropped
      (`sensor_history.is_error = true`, `error_code` set — check via Adminer).
- [ ] The fault is **surfaced in the UI** (state/history), not swallowed.
- [ ] Normal readings still render correctly (readers filter out `is_error = true` rows).

---

## E. Capability behavior configurations — pre-existing uncommitted

- [ ] Device Config page → a capability lists its **available behaviors**
      (`command` / `interval` / `on_demand`) from the catalog.
- [ ] Set a per-instance behavior (e.g. a read **interval**) → it persists after reload.
- [ ] The simulator honors the configured behavior (telemetry cadence changes).
- [ ] Pin assignment still works (`GPIO` slots shown per capability).

---

## F. ESP32 firmware refactor — **needs hardware, not testable from the stack**

~50 changed files: unified `DeviceAction` model, read-verb, heartbeat/fault emission,
clang-format normalization, new I2C/PWM actions.

- [ ] `cd ESP32Code && pio test -e native` (host unit tests — payload validation + topic builder)
- [ ] `pio run` (all 6 hardware envs compile)
- [ ] Flash a board and verify: provisioning, telemetry, command ack, heartbeat, OTA.

---

## G. Cross-cutting sanity

- [ ] `npm run typecheck` → clean ✅
- [ ] `npm run lint` → clean ✅
- [ ] `npx jest tests/unit` → 194 pass ✅
- [ ] `cd backoffice && npx ng build --configuration development && npx ng lint` → clean ✅
- [ ] Migrations apply on a fresh DB (`down -v` → `up -d` → `docker compose run --rm migrate`) ✅
- [ ] **RabbitMQ DLQ is empty** — http://localhost:15672 → Queues → `q.dlq` should be `0`.
- [ ] All queue **consumers attached** (esp. `q.notification.send`, `q.notification.publish`).
- [ ] e2e: `npx jest tests/e2e/notifications.e2e.test.ts` — pass `E2E_USER`/`E2E_PASS` and run
      against a **freshly restarted api** (its repeated logins otherwise trip the rate limiter):
  ```bash
  source .env
  docker compose -f compose.yaml -f compose.dev.yaml restart api && sleep 6
  API_URL=http://localhost:3100 \
  RABBITMQ_URL="amqp://${RABBITMQ_USER:-guest}:${RABBITMQ_PASSWORD:-guest}@localhost:5672" \
  TEST_TARGET=local E2E_USER="$OWNER_USERNAME" E2E_PASS="$OWNER_PASSWORD" \
  npx jest tests/e2e/notifications.e2e.test.ts
  ```

---

## Known issues / notes

- **backoffice container reports `unhealthy`** in `docker ps` — pre-existing healthcheck quirk;
  it serves HTTP 200 fine. Unrelated to these changes.
- **Push (web-push/VAPID) is not wired** — adapter is a no-op until `VAPID_*` are set. Deferred.
- **Sealed secrets for SMTP/VAPID** not created in gitops (needs the cluster key).
- **Prod overlay** does not include `notification-service` — staging only, by design.
- Fixed during verification: dispatcher used to DLQ on a `notification.send` for an unknown
  user (socket emit then FK crash); it now drops cleanly with a warning.
