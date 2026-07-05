# CLAUDE.md — Lattice (iot-smart-home)

TypeScript microservices monorepo for a generic IoT smart home platform.
Detailed references (read when relevant, not upfront):

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — service inventory, event flow, data layer
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — logging, error handling, service structure, shared packages
- [docs/TESTING.md](docs/TESTING.md) — test layout, stack-aware e2e harness, when new code needs tests
- [prisma/SCHEMA.md](prisma/SCHEMA.md) — database ERD + per-table examples
- [SYSTEM-DESIGN-ROADMAP.md](SYSTEM-DESIGN-ROADMAP.md) — living planning doc (feature groups, session log)

## Layout

npm workspaces: `packages/*` (shared `@lattice/*` libs), `services/*` (10 Node services),
`tools/*` (device-sim, generators). Plus `backoffice/` (Angular UI, its own npm project),
`prisma/` (schema + migrations), `ESP32Code/` (PlatformIO firmware — see its own CLAUDE.md),
`tests/` (root Jest suites).

## Commands (run from repo root)

```bash
npm run build:libs        # build packages/ in dependency order — required before services build/run
npm test                  # all Jest suites (e2e self-skips if stack is down)
npm run test:e2e:up       # ephemeral test stack (compose.test.yaml + .env.test) incl. migrations
npm run test:e2e:down     # tear down test stack (-v)
npm run dev:up            # dev stack: compose.yaml + compose.dev.yaml (infra + all services)
npm run dev:down          # stop dev stack
npm run build -w @lattice/<pkg>   # build one workspace
npm run lint              # ESLint (services/packages/tests)
npm run typecheck         # tsc -b (project references)
```

Bring-up order matters: infra → `migrate` container → services. App-level seed rows
(mqtt_user, admin credential from `OWNER_*`) come from `prisma/seed.ts`, not SQL files.

## Working rules

- **Routes are thin delegates.** No business logic, loops, or DB calls in `routes/` files —
  parse/validate input, call a service, shape the response. Logic lives in `services/` modules.
- **Generic IoT naming only.** No domain-specific terminology (farming, crops, or any other
  vertical) in code, seeds, docs, or test data. Devices, sensors, and actions are generic.
- **Schema changes update the ERD.** Any edit to `prisma/schema.prisma` updates
  `prisma/SCHEMA.md` (mermaid ERD + examples) in the same change. New models need a real
  migration — never rely on `db push` drift.
- **Protected files.** `prisma/Dockerfile`, migration job manifests, and root/workspace
  `package.json` scripts are prod-facing: change them only with a concrete verified reason,
  never as a local workaround.
- **Event contract lives in `@lattice/queue`.** New cross-service events go through the
  `RK`/`QUEUES` maps in `packages/queue/src/index.ts` — never publish/consume ad-hoc strings.
- **Firmware ↔ simulator parity.** Any firmware capability change updates
  `tools/device-sim/lib/command-models.js` and `tools/device-sim/PARITY.md`.
- **Never commit/push without asking.** Leave work in the tree for review.
- **Ask before weakening any security boundary** (auth, ACLs, restricted users, permissions).

## Quality gates

- `tsconfig.base.json` is strict; all workspaces extend it. Prettier config at root is law.
- ESLint (typescript-eslint, type-checked) covers `services/`, `packages/`, `tests/`;
  backoffice has its own Angular ESLint setup.
- Pre-commit: lint-staged (prettier + eslint on staged files); commit messages follow
  Conventional Commits (`feat:`, `fix:`, `chore:`, … enforced by commitlint).
- CI: `.github/workflows/checks.yml` gates typecheck/lint/format/tests; per-service
  workflows build+push images and bump the shared version tag (see docs/ARCHITECTURE.md).
