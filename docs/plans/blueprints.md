# Blueprints — Design Plan (F10)

**Status:** built and shelved, not merged · **Designed:** 2026-07-10 · **Shelved:** 2026-07-13
**Branch:** `wip/blueprints-and-ai-rulegen-shelved-2026-07-13` (86 files, +4757/−283)
**Revised:** 2026-07-20 — rewritten from the shelved implementation. The 2026-07-10 design doc
was never committed; this replaces it and describes **what was actually built**, with the
design's unbuilt parts moved to §13.

> The branch also carries the AI rule generator (F11 — `AutomationSuggestion`, ml-router
> rule-builder enricher, suggestion cards). That is a separate feature sharing only
> `buildInstanceContext()`; it is not covered here.

## 1. What a blueprint is

A **blueprint** is an admin-authored, versioned template for a multi-device setup. It declares
device requirements as **slots**, carries **AI context** (free-text notes plus lifecycle
**phases** with per-capability target ranges), and holds **scene templates**. A user _derives_
an instance from it: slots get bound to their real devices, and the templates are snapshot-copied
into real user-owned rows tagged with the instance.

Decisions locked 2026-07-10, all of them honored by the implementation:

| Decision           | Choice                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| Slot matching      | per-slot mode: semantic capability match _or_ exact catalog-device pin               |
| Update propagation | snapshot + version — a template edit never touches a live instance                   |
| Sealed binding     | firmware `DEVICE_ROLE_STR` → manifest `role` → `devices.role_tag`                    |
| Grouped actions    | standalone **Scenes**; blueprints derive them pre-built                              |
| Naming             | generic engine, domain data — domain words exist only as admin-typed runtime content |

## 2. Schema (as built)

Migration `20260710194200_blueprints_and_ai_suggestions`; `prisma/SCHEMA.md` updated in the same
commit (+253 lines).

**Definition side (admin-owned)**

- `Blueprint` — `key` unique, `name`, `description`, `version Int`, `status draft|published`,
  `owner_user_id Int?` (null = system template), `context_notes Text?`.
- `BlueprintSlot` — `key` (unique per blueprint), `label`, `required`, `min_count`, `max_count`,
  `match_mode capability|device_pin`, `device_id FK?` (pin mode), `role_tag String?`, `sealed`.
- `BlueprintSlotCapability` — `(slot_id, capability_key)` unique, optional `device_type` /
  `device_version` constraints. **Multiple rows mean AND** — the bound device must expose all of
  them (e.g. one combined temp+humidity sensor).
- `BlueprintPhase` — `key`, `name`, `ordinal`, `duration_value Int?` + `duration_unit
hours|days|weeks`, `context_notes`. Duration is **descriptive only** — nothing schedules on it.
- `BlueprintPhaseTargetRange` — one row per `(phase, capability_key)` with `min_value`/`max_value`.
- `BlueprintScene` / `BlueprintSceneMember` — members reference `(slot_key, capability_key,
target_state, delay_seconds, ordinal)`, resolved to concrete actions at derive time.

**Instance side (user-owned)**

- `BlueprintInstance` — `user_id`, `blueprint_id`, `blueprint_version` (snapshot marker), `name`,
  `current_phase_id?`, `phase_started_at?`. Unique `(user_id, blueprint_id, name)`.
- `BlueprintSlotBinding` — `instance_id`, `slot_key` (plain string, not FK — survives template
  edits), `user_device_id`, `sealed`.
- Nullable `blueprint_instance_id` (**onDelete: SetNull**) on `Scene`, `Pipeline`, `UserRule`,
  `UserActionGroup`.
- `Scene` / `SceneMember` — standalone (§4).

**Two deliberate departures from the original design**, both documented in schema comments:

- Phase target ranges are a **table, not a JSON blob** — so per-key alerting and admin-form
  validation can query by `capability_key`. Same rationale as `BlueprintSlotCapability`.
- Phase duration is **value + unit, unnormalized** — a "3 hours" phase and a "6 weeks" phase both
  round-trip exactly as authored. Mirrors `PipelineSensor.window_value/window_unit`.

## 3. Derive (`services/api/src/services/blueprints.service.ts`)

Request: `{ blueprint_id, name, bindings: [{ slot_key, user_device_ids: number[] }] }` — note
**multi-device per slot**, honoring `min_count`/`max_count`.

1. Blueprint must exist and be `published` (404 / 400). Duplicate instance name → **409**.
2. `validateBindings` re-runs the matcher **server-side for every device** — the client-supplied
   binding is never trusted. Under/over count → 400; ineligible device → 400.
3. A `sealed` slot rejects a device already sealed to another instance → **409**.
4. In one transaction: create instance (current phase = first phase, `phase_started_at = now`),
   binding rows, **one `UserActionGroup` named after the instance**, and one `Scene` per template
   named `"<instance>: <scene>"`.

`resolveSceneMembers` fans a template member out to every bound device at that slot that has an
action for the capability; devices missing it are **silently skipped** — a scene is a
convenience and shouldn't fail the derive.

**Matcher** (`blueprints-matcher.ts`) — one shared module used by both the derive validation and
the `GET /:id/candidates` precheck. Loads the user's devices, then: pin mode filters on
`device_type_id`; capability mode requires the catalog device to expose every `capability_key`,
then applies optional `device_type` / `device_version` filters; sealed slots filter on
`role_tag`. Filtering is in-memory over the user's device list.

`buildInstanceContext(instanceId)` lives at the bottom of `blueprints.service.ts` and returns
`{ instance_id, instance_name, blueprint_name, context_notes, current_phase: { name,
context_notes, target_ranges } | null }`. ml-router queries the same tables directly for its own
context provider — **no HTTP hop between services**.

## 4. Scenes (standalone)

`GET/POST /api/scenes`, `PUT/DELETE /api/scenes/:id`, `POST /api/scenes/:id/execute`.
Ownership checked via the existing `ensureActionOwnership`; member ordinals must be unique.
Execute fans out **one `ACTION_REQUESTED` per member — no new routing key**; members with
`delay_seconds > 0` fire from a `setTimeout` after the HTTP response returns.

## 5. Sealed devices

Firmware → catalog path, fully plumbed: optional `DEVICE_ROLE_STR` flag in `platformio.ini`
(third line-parsed flag, documented in the header comment) → `generate-manifests.mjs` parses it
and passes `-DGEN_DEVICE_ROLE` → manifest `role` → `seed-catalog.ts` upserts `devices.role_tag`,
**re-asserted on every reseed** so flipping the build flag needs no manual catalog edit.

Enforcement is a read-only guard in `device.mgmt.service.ts` (`ensureNotSealed`): a device with
a sealed binding cannot be **renamed, deleted, or re-pinned** → 403 with a plain-language reason.
It never blocks the binding itself.

## 6. Grouped notifications

`templates.ts` prefixes the rendered **body** with `instanceName` when a producer passes it in
`data` — `"Garage Setup: Rule \"…\" fired."`. The title is untouched.

## 7. API surface

**Admin** (`requireAppToken` + `requireAdmin`): `GET /api/admin/blueprints`, `GET/PUT/DELETE
/:id`, `POST /`, `PATCH /:id/status`. Update is a wholesale replace of slots/phases/scenes and
**bumps `version`**; `PATCH /status` only flips draft↔published. Delete is refused with 409 while
any instance exists.

**User:** `GET /api/blueprints` (published only), `GET /:id`, `GET /:id/candidates`,
`GET/POST /api/blueprint-instances`, `GET/DELETE /:id`, `PATCH /:id/phase`.

## 8. UI (backoffice)

New `/blueprints` route (gallery + derive dialog), `/admin/blueprints` builder, scene editor
dialog, scene tiles on the dashboard, instance chip on group tiles, and an Automations-tab entry
point.

## 9. Instance deletion — inverted from the original design

The 2026-07-10 plan said delete-instance removes derived entities. **As built it does the
opposite:** `onDelete: SetNull` on all four tag columns means deleting an instance untags its
scenes/pipelines/rules/group and leaves them running. The schema comment states this
deliberately — _deleting an instance never deletes a user's live automation_. This is the safer
default and should stay; §13 covers the "clean up too" option as an explicit opt-in.

## 10. Review findings — fix before merge

1. **Derive hijacks existing action grouping.** After creating the instance group, derive runs
   `updateMany` over **every action of every bound device**, setting `group_id` to the new group.
   A user who had those actions organized loses that grouping silently, and nothing restores it
   on instance delete. Should only group actions the blueprint actually references, or ask.
2. **Delayed scene members are lost on restart.** `setTimeout` in the API process means a deploy,
   crash, or pod eviction mid-scene drops every pending member with no trace. The rest of the
   platform schedules through the queue; this should too (or delays should be refused in v1).
3. **No re-derive at all.** `POST /instances/:id/rederive` was in the design and is absent.
   `Blueprint.update` bumps `version` while instances keep their old `blueprint_version`, so the
   data model can already say "update available" — but there is no way to act on it. Either build
   it or drop the version-drift affordance so the UI doesn't imply something it can't do.
4. **`version` bumps on edit, not on publish.** Editing a draft repeatedly inflates the version a
   derive will later snapshot, so `blueprint_version` doesn't identify a _published_ revision.
   Bumping in `setStatus('published')` is the behavior the snapshot decision assumed.
5. **`device_version` is exact string equality.** The design called for `min_device_version`. As
   built, a slot pinned to `v2.0.310` stops matching at `v2.0.311` — every firmware bump silently
   breaks published blueprints. Needs semver comparison or the constraint should be dropped.
6. **Grouped notifications are one-ended.** `templates.ts` consumes `data.instanceName`, but no
   producer on the branch sets it — automation-worker and ml-router were never touched for this.
   The feature is inert until they tag it, and the payload extension never went through
   `@lattice/queue` (hard rule: event contract lives there).
7. **Sealed lock has holes.** Group moves and behavior edits are not guarded (design §5 listed
   them), there is no auto-bind when a role-matching device provisions into an unfilled sealed
   slot, and there is no rebind flow — so a sealed device that dies leaves the instance stuck with
   a binding the user cannot clear except by deleting the instance.
8. **Matcher is N+1-shaped.** It loads every user device, then queries capabilities per derive and
   again per slot for `/candidates`. Fine at current scale, worth a single grouped query before
   any blueprint with many slots ships.

## 11. What the design specified and the branch does not have

- `BlueprintPipeline*` and `BlueprintRule*` template models — **not built**. Derive produces
  scenes and a group only. The instance tag columns on `Pipeline`/`UserRule` exist and the
  relations are declared, so a pipeline or rule can be _tagged_ to an instance, but a blueprint
  cannot _carry_ one. This is the single largest gap versus the original design, and it removes
  the main reason the AI-context contract exists.
- `Blueprint.monitor_window` (quiet hours / active monitoring windows) and the
  `delivery/preferences.ts` suppression that consumed it — **dropped entirely**.
- Dashboard context-group tile with phase indicator and health strip — only the instance chip on
  `group-tile` landed.
- F12.1 import/export endpoints reusing the admin service.
- `tools/device-sim/PARITY.md` note for the manifest `role` field (parity rule).

## 12. If this is picked back up

Order that keeps each step verifiable:

1. Fix findings 1, 2, 4, 5 — all local, all cheap, all silently wrong today.
2. Decide re-derive: build it, or remove the version-drift affordance (finding 3).
3. Land the notification producers through `@lattice/queue` (finding 6).
4. Sealed rebind flow + auto-bind (finding 7) before any sealed blueprint reaches a user.
5. Then reassess whether `BlueprintPipeline*` / `BlueprintRule*` (§11) are still wanted, or
   whether tagging user-created pipelines to an instance is enough.

## 13. Compliance checklist

- [x] Generic naming in code/seeds/tests; domain words only as admin-typed runtime data.
- [x] `prisma/SCHEMA.md` ERD updated with the migration; real migration, no `db push`.
- [x] Routes thin — matcher/derive/validation all in services.
- [ ] Notification payload extension goes through `@lattice/queue` maps + zod schemas.
- [ ] `tools/device-sim/PARITY.md` note for the manifest `role` field.
- [x] Nothing committed to master; work parked on the shelve branch.
