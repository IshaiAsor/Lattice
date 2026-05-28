---
name: run-iot-smart-home
description: Start, stop, and check the full IoT smart home Docker Compose stack. Use when asked to run, start, stop, restart, or check the compose stack, infrastructure, services, EMQX, PostgreSQL, Redis, or the full stack.
---

# run-iot-smart-home Skill

Manages the IoT smart home Docker Compose stack defined in `compose.yaml` at the project root.

## Prerequisites

- Docker 29+ and Docker Compose v5+ installed and running
- A `.env` file at the project root with all required variables (see below)
- TLS certificates present in `certs/` (ca.pem, server.pem, server.key)
- Init SQL scripts present in `local-sql/` (run automatically by PostgreSQL on first start)

## Required `.env` Variables

The following variables must be set in `iot-smart-home/.env`:

**Database (superuser)**
- `DB_HOST`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

**Database (app user)**
- `BACKEND_DB_USER`
- `BACKEND_DB_PASSWORD`

**Prisma**
- `DATABASE_URL`

**MQTT / EMQX**
- `MQTT_SERVER_NAME`
- `MQTT_APP_USERNAME`
- `MQTT_APP_PASSWORD`
- `MQTT_PORT`
- `MQTT_CA_CERT_PATH`
- `MQTT_VALIDATE_CERT`
- `EMQX_DB_SERVER`
- `EMQX_DB_USERNAME`
- `EMQX_DB_PASSWORD`
- `EMQX_DASHBOARD_USERNAME`
- `EMQX_DASHBOARD_PASSWORD`

**Google OAuth / Smart Home**
- `GOOGLE_AUTH_CLIENT_ID`
- `GOOGLE_AUTH_CLIENT_SECRET`
- `GOOGLE_SIGN_IN_CLIENT_ID`
- `GOOGLE_SIGN_IN_CLIENT_SECRET`

**Backend server**
- `PORT`
- `BASE_URL`

**JWT**
- `JWT_SECRET`
- `DEVICE_PROVISION_EXPIRES_IN`
- `JWT_APP_USAGE_EXPIRES_IN`
- `JWT_APP_USAGE_REFRESH_EXPIRES_IN`
- `JWT_DEVICE_USAGE_EXPIRES_IN`
- `JWT_DEVICE_TEMP_USAGE_EXPIRES_IN`
- `JWT_DEVICE_USAGE_REFRESH_EXPIRES_IN`
- `JWT_GOOGLE_SHORT_LIVED_EXPIRES_IN`
- `JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN`
- `JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH`

**Redis**
- `REDIS_USER`
- `REDIS_PASSWORD`
- `REDIS_URL`

**Prisma migrations (only needed when running the `migrate` profile)**
- `OWNER_EMAIL`
- `OWNER_PASSWORD`
- `OWNER_USERNAME`

## Services and Endpoints

| Service        | Container name  | Port(s)                       | URL / Notes                          |
|----------------|-----------------|-------------------------------|--------------------------------------|
| EMQX broker    | `emqx`          | 1883 (MQTT), 8883 (MQTTS)     | mqtt://localhost:1883                 |
| EMQX dashboard | `emqx`          | 18083                         | http://localhost:18083                |
| PostgreSQL     | `postgres_db`   | 5432                          | postgres://localhost:5432             |
| Adminer UI     | `adminer_ui`    | 8080                          | http://localhost:8080                 |
| Redis          | `redis_cache`   | 6379                          | redis://localhost:6379                |
| OTA manager    | `ota-manager`   | 3001 (host) → 3000 (internal) | http://localhost:3001                 |

EMQX depends on PostgreSQL being healthy before starting. Adminer also waits for the PostgreSQL healthcheck.

## Common Commands

All commands must be run from `iot-smart-home/` (the project root).

### Start the full stack
```powershell
docker compose up -d
```

### Stop the stack
```powershell
docker compose down
```

### Stop and remove volumes (full reset)
```powershell
docker compose down -v
```

### Check service status
```powershell
docker compose ps
```

### Follow logs for a service
```powershell
docker compose logs -f emqx
docker compose logs -f postgres
docker compose logs -f cache
docker compose logs -f ota-manager
docker compose logs -f adminer
```

### Validate the compose file
```powershell
docker compose config --quiet
```

## Prisma Migrations

Migrations are run as a one-shot container using the `migrate` profile. This is NOT included in the default `docker compose up`.

### Run migrations (and seed data)
```powershell
docker compose --profile migrate run --rm migrate
```

Requires `OWNER_EMAIL`, `OWNER_PASSWORD`, and `OWNER_USERNAME` to be set in `.env` (used to seed the initial owner account).

### Regenerate Prisma client after schema changes
```powershell
docker compose --profile generate run --rm generate
```

## Atlas Migrations (legacy)

If using Atlas-based migrations, rehash the migration checksum after editing a migration file:
```powershell
docker compose run atlas-hash
```

## OTA Firmware

Place firmware `.bin` files in `firmware-storage/`. The OTA manager mounts this directory and serves firmware to devices over MQTT.

## TLS Certificates (EMQX)

EMQX uses the certificates in `certs/` for the secure MQTT listener on port 8883:
- `certs/ca.pem` — CA certificate
- `certs/server.pem` — Server certificate
- `certs/server.key` — Server private key

These are mounted read-only into the EMQX container.

## Init SQL Scripts

PostgreSQL runs these scripts on first database initialization (from `local-sql/`, mounted as `docker-entrypoint-initdb.d`):
- `010.init-app-user.sh` — Creates application database user and roles
- `091.test-seeds.sql` — Test seed data

These only run when the `pg-data` volume is empty (first start or after `docker compose down -v`).

## MQTT Authentication

EMQX uses two authentication layers in order:
1. **JWT** — ESP32 devices authenticate with JWT tokens (signed with `JWT_SECRET`)
2. **PostgreSQL** — The backend app and humans authenticate via bcrypt password hashes stored in the `mqtt_user` table

ACL rules are defined in `acl.conf` at the project root (mounted into EMQX).
