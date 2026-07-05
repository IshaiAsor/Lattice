# Testing

All Jest suites live at the repo root under `tests/` (root `jest.config.js`, ts-jest,
30s timeout). Services and packages do not have their own test setups.

```bash
npm test                # everything (e2e self-skips when the stack is down)
npm run test:e2e        # e2e only
npm run test:e2e:up     # start ephemeral test stack (compose.test.yaml + .env.test) + migrate
npm run test:e2e:down   # tear it down (-v)
```

## Layout

- `tests/unit/` — pure logic, no stack, plain assertions. Fast, always runs.
- `tests/e2e/` — drives the real running stack end-to-end via the **SimDevice** fixture
  (`tools/device-sim/lib/sim-device.js`, plain JS): provision → online → telemetry →
  command/ack round-trips.
- `tests/e2e/helpers/stack.ts` — the shared harness: env loading (`.env.test` preferred),
  `API_URL`/`GATEWAY_URL`/MQTT endpoints, `login()`, `apiGet()`, `poll()`,
  `backendPublisher()`.

## The skip-when-down convention (mandatory for e2e)

New e2e cases use `itStack()` from the harness, never bare `it()`:

```ts
import { itStack, stackUp, login } from './helpers/stack';

itStack('device ack updates action state', async () => { ... });
```

`itStack` probes `/health` on api + device-gateway; if the stack is down it logs
`SKIP (stack down)` and passes. This keeps `npm test` green on a cold checkout and lets CI
run unit tests without infrastructure. Don't break this property.

## Rules for new code

- **New pure logic** (parsers, validators, resolvers, mappers) → unit test in `tests/unit/`.
  If the logic is buried in a service, extract it to a testable function first.
- **New event flow** (new routing key, consumer, or device interaction) → e2e case in
  `tests/e2e/` using SimDevice + `poll()` for async assertions.
- **Firmware capability changes** → update `tools/device-sim/lib/command-models.js`
  (mirrors `BaseCommandAction::validateActionPayload`) and `tools/device-sim/PARITY.md`,
  then extend the e2e coverage for the new capability.
- Bug fixes come with a test that fails before the fix when practical.
- Tests never hard-depend on a developer's personal `.env` stack — use the harness
  constants and the ephemeral test stack.
