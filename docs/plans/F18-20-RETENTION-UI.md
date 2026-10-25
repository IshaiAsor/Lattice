# F18.20 — Retention UI for every scope

**Status:** built and verified live 2026-09-22 (uncommitted) · **Covers:** F18.20 · **Builds on:**
F18.12 (scopes), F18.21 (sealed scope), F18.22 (usage) · **Mockups:**
https://claude.ai/artifact/P5R9c5vRbtZYVP69Rxo1wC

Retention — how long history is kept before the cleanup deletes it — resolves across six scopes:
sensor (action) → device → blueprint → sealed template → user → platform. Before this, only the
platform list (admin retention page), the user's own list (Settings) and sealed templates (F18.21)
had screens. The blueprint, device and sensor scopes worked in the backend and the cleanup obeyed
them, but nothing a person could click reached them, and custom bucket sizes could be deleted by the
API but not from any screen.

---

## Decisions taken with the user

1. **Everything retention lacks, not blueprints alone** (2026-09-22). The scope was first narrowed to
   blueprint retention and the device/sensor backend reverted (2026-09-17), then widened again to
   every missing screen; the reverted design was re-applied.
2. **Blueprint retention on both screens** — the admin builder sets a list per slot action; the user's
   setup page shows what each action keeps and who decided, and lets the user keep their own.
3. **The user's own list on a setup is stored at the ACTION scope** — there is no setup scope, and
   action already sits above blueprint. It belongs to the device's action and stays if the device
   leaves the setup; the editor says so.
4. **Blueprint lists are live, not drafted** — saved on their own and applied at once to every
   existing setup, as the API already worked and as sealed lists behave. A warning strip says so.
5. **Editing lives on the device page.** The dashboard card's "Data kept…" sheet is read-only and
   deep-links to the sensor's row (`#/devices/:id?tab=data&action=:actionId`).
6. **Undo** on the notice after every save or removal (device tab, setup tab).

## What the code check found — all fixed

- Device, action and blueprint lists for `command`/`device_event` were accepted, stored, shown and
  never applied (those windows resolve per user). Now refused at every scope below the user's.
- A blueprint list could never be cleared: no DELETE route, and a PUT of `[]` is refused by
  `assertTierList`. Now `DELETE /api/admin/retention/blueprints/:id/:slot/:action/:kind`.
- Blueprint lists were stranded by a blueprint save that dropped or re-templated a slot, by a
  blueprint delete (FK cascade, no log entry) and by a sealed-template save that removed an entry.
  All three now drop and log them (`dropBlueprintTiers`).
- Blueprint writes bypassed `replaceTiers`, the one audited write. Now `replaceBlueprintTiers`.
- `/effective` was scope-kind only, one call per action per kind, with no name and no fallback.
- The tier editor's Discard left edited values on screen (F18.21). Fixed in `app-scoped-tier-list`
  (resets on content change, not identity — a host reload hands every row a new array) and in
  Settings (`#ed` + `reset()` on Discard, Save and Reset, as the sealed page already did).
- Found while verifying: the global error interceptor stacked a generic "Error occured, 400" toast
  on top of each screen's own, better message. Retention writes now pass `SILENT_ERRORS`.

## What was built

**Backend** (`services/api`, `packages/retention`)

- `describeResolution(input, applies)` in `@lattice/retention` beside `resolveTiers`: what applies,
  what removing the action's list falls back to, and each scope's state (answering first).
- `retention-device-resolution.ts` — `loadDeviceResolution` assembles one device's whole input in a
  fixed number of queries; `actionRetentionView` shapes an action. Shared by the device read, the
  setup read and `effectiveForAction` (the chart's tier choice), so screen and chart cannot disagree.
- `GET /api/retention/scopes/devices/:id/effective` (declared before `/devices/:id/:kind`) and
  `GET /api/retention/scopes/setups/:instanceId` (owner only; only a slot's own actions, via the pure
  `slotActionsOf`). `usageByAction` gives per-sensor stored rows in three grouped queries.
- `GET /api/admin/retention/blueprints/:id` reshaped to per saved slot → action, with the kind
  (capability `implementation_type`) and the sealed list it falls back to; PUT/DELETE return it.

**Backoffice**

- Shared: `app-scoped-tier-list` (Follows X · Customise / editor / Save · Discard / Remove list),
  `app-scope-ladder` (the six-step "who decides" strip), `app-scope-chip` (one colour per scope),
  helpers `tierSummary`, `scopeLabel`, `followsPhrase`, `ladderName` with a Karma spec.
- Device page: a Data tab (`app-device-retention`) — a list for the device per kind, and per sensor
  the chip, what is kept, stored rows, the strip and its own editor.
- Dashboard: "Data kept…" in every action card's menu opens `app-sensor-retention-sheet` — opened by
  the card itself, so it works on the dashboard, in a group sheet and on a setup tile alike.
- Admin blueprint builder: `app-blueprint-slot-retention` replaces the slot's plain action list;
  editable on saved slots whose saved template matches the draft, else "Save the blueprint".
- Setup page: a Data tab (`app-setup-retention`) with "the blueprint sets N of M; you keep your own
  for K" and "Use the blueprint's everywhere".
- Custom-size dialog is now "Bucket sizes": the add form plus the custom sizes, Remove on your own
  (any, for an admin), the server's refusal under the row; removed sizes stop being offered.

## Verification (2026-09-22)

- Gates: `tsc -b`, root ESLint, Prettier, `jest tests/unit` 695/695, backoffice production build,
  backoffice ESLint on every touched file, Karma 17/17.
- API against the dev stack: 29/29 — device and sensor lists, fallbacks, neighbours untouched,
  kind refusals, the chart path, the reshaped admin read, the setup read (blueprint decides → own
  list wins → falls back), 404s, and the three stranding paths each dropping and logging.
- UI, `ng serve` on `localhost:4200`, driven headlessly at 1280 and 390px: device tab (16 checks),
  deep link (6), sheet (5), builder (6), setup tab (10 at each width), bucket sizes (7), Settings
  Discard (3). Every check cleaned up the lists and sizes it created.

## Out of scope

Per-sensor command and device-event windows (per user by design); commit and deploy.
