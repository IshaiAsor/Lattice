# F15 — `notification-service` Implementation Plan

> Multi-channel user notifications for Lattice. Companion to the F15 rows in
> [SYSTEM-DESIGN-ROADMAP.md](SYSTEM-DESIGN-ROADMAP.md). This file expands the roadmap spec
> into an actionable build with the pickup decisions locked.

## Locked decisions (2026-07-07)

| Decision               | Choice                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 channels            | **In-app (socket) + Email + Push** (SMS deferred; adapter stubbed no-op)                                                                     |
| Scope                  | **Full group F15.1–F15.8**, including registration email verification                                                                        |
| Email provider         | **SMTP via nodemailer** (provider-agnostic; Gmail app-password / Mailgun SMTP / etc.)                                                        |
| Push provider          | **web-push / VAPID** (only client today is the Angular backoffice; no FCM/mobile dependency) — revisit FCM when a native app exists          |
| Dedupe window          | **5 min** default per `(userId, eventType)`, overridable via `dedupeKey`                                                                     |
| Default prefs (no row) | in-app = on for all; email = on for `emergency` + `email_verification` only; push = off until subscribed; emergency in-app can't be silenced |

## Architecture & ownership

Two-lane, queue-driven. Groundwork already exists in `@lattice/queue`
(`RK.NOTIFICATION_PUBLISH` / `q.notification.publish`), and `digest-service` already emits
`ota_available` best-effort (dropped until this service exists).

- **`notification-service` (port 3011 — 3009 is ml-router)** — stateless consumer + channel adapters. No user DB
  _writes_; reads prefs/history via `@lattice/prisma-client`.
- **`api`** owns all user DB writes: prefs/history CRUD + email-verification endpoints.
- **In-app channel reuses the socket path** — `@socket.io/redis-emitter` → `user_{userId}`
  room, new `SOCKET_EVENTS.NOTIFICATION` event (mirrors `services/digest-service/src/socket/emitter.ts`).
  Zero new infra.

### Two routing keys

- `notification.publish` — **device-scoped** events; the service resolves owners
  (existing `ota_available`). Already declared + emitted.
- `notification.send` `{ userId, eventType, data, dedupeKey?, channels? }` — **user-targeted**;
  producers that already know the user (emergency, rule-fire, email-verification) publish
  directly. **Needs adding.**

## Shared-contract additions

**`packages/queue`:**

1. `RK.NOTIFICATION_SEND = 'notification.send'`, `QUEUES.NOTIFICATION_SEND = 'q.notification.send'`,
   exact binding + `DLQ_ARGS`.
2. `NotificationSendPayload` type + `notificationSendSchema`, registered in `EVENT_SCHEMAS`.
3. Expand `NotificationPublishPayload.type` union beyond `'ota_available'` as fan-out producers grow.

**`packages/ioredis`:** `SOCKET_EVENTS.NOTIFICATION`.

**Tests:** mirror the new schemas into `tests/unit/platform.queue-contracts.test.ts` and `tests/sanity`.

## Schema — one new migration via `migrate diff` (init is frozen)

- `NotificationPreference` — `@@unique([user_id, channel, event_type])`
- `NotificationHistory` — `@@index([user_id, created_at])`
- `User.email_verified Boolean @default(false)` + `User.email_verification_token String? @unique`

Update `prisma/SCHEMA.md` (ERD + examples) in the **same** change (hard rule).

## Build order

| #     | Deliverable                                                                                                                                                                                                                    | Key files                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| F15.1 | Service skeleton (express, `env.config.ts`, exception mw, `/health`) + `Channel` interface; each adapter self-disables to no-op/log when creds absent                                                                          | `services/notification-service/src/**`, `channels/{inapp,email,push}.ts` |
| F15.2 | Prefs + history schema; CRUD in **api** (`/api/notifications/preferences`, `/api/notifications` inbox read, mark-read)                                                                                                         | api routes/services + migration                                          |
| F15.3 | `q.notification.send` consumer → resolve prefs → fan out to enabled channels; payload-driven templating; Valkey dedupe + rate-limit keyed `(userId, eventType)`                                                                | notification-service consumer + `templates/`                             |
| F15.4 | Wire producers: bind `q.notification.publish` (resolve OTA owners → per-user send); emergency (F9), rule-fire (F6), device-offline (`q.device.state.changed`)                                                                  | notification-service + producer services                                 |
| F15.5 | Backoffice inbox (notification center + unread badge + mark-read) + preferences page                                                                                                                                           | `backoffice/src/app/components/notifications/**`                         |
| F15.6 | CI `lattice-notification-service` + `k8s/base/notification-service` + staging overlay + Kargo (auto-promote staging) + sealed secrets (SMTP, VAPID). Dockerfile copies nested `node_modules` (nodemailer/web-push won't hoist) | infra                                                                    |
| F15.7 | `email_verified` + token columns (folded into the F15.2 migration)                                                                                                                                                             | migration                                                                |
| F15.8 | Registration email-verification flow (below)                                                                                                                                                                                   | api auth + backoffice                                                    |
| F15.9 | **Password-reset flow** (forgot-password → email → reset), parallel to F15.8 (below)                                                                                                                                           | api auth + backoffice + migration                                        |

## Local dev + editor wiring (was missing — required for every service in this repo)

- **compose**: add a `notification-service` service to `compose.yaml` (image/build, `depends_on`
  rabbitmq + valkey, env: `RABBITMQ_URL`, `VALKEY_*`, `DATABASE_URL`, `APP_BASE_URL`, `SMTP_*`,
  `VAPID_*`, `NOTIFICATION_DEDUPE_TTL`) and its dev override in `compose.dev.yaml`
  (bind-mount + `npm run dev`, port 3011 exposed). SMTP/VAPID left unset locally → adapters no-op.
- **VSCode**: add a launch config + build/watch task for `notification-service` (mirror the
  google-home/socket-server entries).
- **`.env` / docs**: document the new env keys (SMTP, VAPID, dedupe TTL, APP_BASE_URL) wherever
  the other services' keys are listed.

## Testing (was under-specified)

- **Unit (host, no stack)** — pure logic extracted so it's Arduino-of-Node testable:
  `defaultPrefEnabled`/`isPrefLocked` matrix (in `@lattice/queue`), preference resolution
  (row-overlay-on-default), dedupe key-building, and template rendering per `eventType`. New
  Jest suites under `tests/unit/` (e.g. `platform.notification-prefs.test.ts`).
- **Contract** — `notification.send` case in `platform.queue-contracts.test.ts` (**done in chunk 1**).
- **e2e (stack up)** — publish `notification.send` → assert a `notification_history` row is
  written and an `action`-less `notification` socket event reaches the user room; plus
  verify-email and reset-password happy-paths through the api. New suite under `tests/e2e/`.

## Email-verification flow (F15.8)

Changes `services/api/src/services/register.service.ts`, which today mints a JWT immediately.

- **`POST /register`** stops returning a token → saves `crypto.randomUUID()` token, publishes
  `notification.send` (`eventType: email_verification`, `data: { username, verifyUrl }`),
  returns `{ pendingVerification: true }` (HTTP **202**).
- **`GET /api/auth/verify-email?token=`** → clears token, sets `email_verified: true`, returns
  full `app_usage` JWT + user (lands straight into app).
- **`POST /api/auth/resend-verification`** `{ email }` (auth rate-limiter) → 404 no pending /
  409 already verified.
- **Login gate**: `loginWithCredentials` throws `403 { error: 'email_not_verified', email }`
  when unverified. **Google login auto-sets `email_verified: true`** — no gate.
- **Backoffice**: post-register "check your inbox" page + `/verify-email?token=` landing page.

## Password-reset flow (F15.9)

Parallel to F15.8, reusing the email channel. Schema adds `password_reset_token String? @unique`

- `password_reset_expires DateTime?` to `User` (folded into the same unapplied migration).

* **`POST /api/auth/forgot-password`** `{ email }` (auth rate-limiter) → **always 202** (never
  leak whether the email exists). If a credential user exists (has a password; Google-only
  accounts are skipped), set a `crypto.randomUUID()` token + short expiry (e.g. 1h) and publish
  `notification.send` (`eventType: password_reset`, `data: { username, resetUrl }`).
* **`POST /api/auth/reset-password`** `{ token, password }` → validate token + non-expired,
  enforce password rules, set the new hash, clear token/expiry. Returns 204 (user logs in fresh)
  — no auto-JWT, so a leaked link can't also grant a session.
* **`password_reset` event type** added to the catalog + a template.
* **Backoffice**: "forgot password?" link on login → request page; `/reset-password?token=`
  page that posts the new password and redirects to login on success.

Common interface `send(userId, eventType, data): Promise<void>`; each adapter loads its
provider only if creds present, else no-op/log.

- **in-app** — `@socket.io/redis-emitter` → `user_{userId}`, `SOCKET_EVENTS.NOTIFICATION`;
  also persists a `NotificationHistory` row for the inbox.
- **email** — nodemailer SMTP transport; per-event HTML template.
- **push** — web-push (VAPID); requires a stored subscription per user (browser
  `PushSubscription`) — add a `/api/notifications/push-subscription` endpoint in F15.2.
- **sms** — stubbed no-op (Twilio slot reserved, not built in v1).

## Dedupe + rate-limit

Valkey keys `notif:dedupe:{userId}:{eventType}[:{dedupeKey}]` with a 5-min TTL (SET NX);
a hit suppresses the duplicate. Separate token-bucket per `(userId, eventType)` guards against
floods (e.g. a flapping device-offline).

## Infra notes

- Dockerfile **must** `COPY services/notification-service/node_modules` in the runtime stage
  (nodemailer/web-push don't hoist — see `reference_service_dockerfile_nested_deps`).
- Sealed secrets: `SMTP_*` (host/port/user/pass/from), `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`.
- Kargo `notification-service-staging` stage needs `autoPromotionEnabled: true`; prod manual.

## Suggested landing chunks (3 reviewable PRs)

1. **Contract + schema + skeleton** — ✅ **LANDED (chunk 1, uncommitted)**. F15.1 + queue/ioredis
   additions + migration + service skeleton. Typecheck/lint/193 tests green.
2. **Delivery core** — F15.2–15.4 + unit tests + compose/launch wiring. Prefs CRUD, send consumer
   (templating + dedupe), producers wired. Backend-complete, testable via `curl` + publishing.
3. **UI + auth flows + infra** — F15.5–15.9. Inbox/prefs UI, email-verification + password-reset
   register/login rework, forgot/reset UI, e2e suite, CI/k8s/Kargo/secrets, real VAPID wiring.

Push (web-push) ships as a stubbed adapter in chunks 1–2, real VAPID wiring in chunk 3 — never blocks the core.

## Open items to confirm at implementation time

- web-push vs FCM (defaulting to web-push).
- Exact `eventType` catalog (`ota_available`, `emergency`, `rule_fired`, `device_offline`,
  `email_verification`, …) and per-event default channel matrix.
- Whether device-offline notifications need a debounce beyond the rate-limit (flapping links).
