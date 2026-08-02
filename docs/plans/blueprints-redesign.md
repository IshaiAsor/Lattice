# Blueprints — Redesign (F10)

**Status:** design, not built · **Written:** 2026-07-20
**Supersedes:** the shelved implementation on `wip/blueprints-and-ai-rulegen-shelved-2026-07-13`
(post-mortem: [blueprints.md](blueprints.md) — read that only for what went wrong; none of it is
being revived).

---

## Contents

1. [The idea in one page](#1-the-idea-in-one-page)
2. [Concepts](#2-concepts)
3. [The parameter mechanism](#3-the-parameter-mechanism)
4. [Schema](#4-schema)
5. [Flow A — admin authors a blueprint](#flow-a--admin-authors-a-blueprint)
6. [Flow B — user derives an instance](#flow-b--user-derives-an-instance)
7. [Flow C — a derived rule fires](#flow-c--a-derived-rule-fires)
8. [Flow D — a phase advances](#flow-d--a-phase-advances)
9. [Flow E — user overrides a parameter](#flow-e--user-overrides-a-parameter)
10. [Flow F — admin releases v2, instances reconcile](#flow-f--admin-releases-v2-instances-reconcile)
11. [Flow G — a notification carries its area](#flow-g--a-notification-carries-its-area)
12. [What this does NOT do](#12-what-this-does-not-do)
13. [Build order](#13-build-order)

---

## 1. The idea in one page

A user plugs in five devices. Today they must: name each one, assign pins, pick behaviors, set
intervals, create an action group, build scenes, write threshold rules, and wire a pipeline. Most
users will not.

A **blueprint** is an admin-authored description of a whole working setup. A user picks one, the
system binds their real devices to its **slots**, and it materializes everything above in one
transaction. That is the onboarding job.

Two things make this different from the shelved attempt:

**It reuses sealed templates instead of replacing them.** Master already has an admin-authored,
version-ranged, key-referenced, idempotently-materialized template system — for _one device type_.
A blueprint slot just points at one. Per-device config is not reimplemented; the blueprint's
contribution is the multi-device layer above it.

**Derived automations store references, not values.** A derived rule holds
`threshold_value = "@phase.humidity.min"`, resolved at evaluation time. This is what lets a
blueprint update, a lifecycle phase advance, and a user's own edit all coexist without fighting —
see [§3](#3-the-parameter-mechanism).

```
Blueprint (admin, versioned, published)
    │  slots ─────────────► SealedTemplate (existing, per device type)
    │  params ────────────► declared tuning surface
    │  phases ────────────► ordered, each sets values for params
    │  templates ─────────► scene / rule / pipeline definitions using @param refs
    │
    └─ derive ─┐
               ▼
         BlueprintInstance (user)
            ├── Area ..................... "these devices belong together"
            ├── SlotBindings ............. slot_key → real UserDevice
            ├── ParamOverrides ........... the user's own tuning
            └── derived Scene / UserRule / Pipeline rows
                    (tagged with instance + template key + user_modified)
```

> **Naming note.** Every domain-flavored string below (`Reservoir Setup`, `Seedling`) is
> **runtime content an admin types into the builder** — exactly like a playlist name. It never
> appears in code, seeds, or tests. The engine is generic; only the data is specific.

---

## 2. Concepts

| Concept             | What it is                                                              | Owned by       |
| ------------------- | ----------------------------------------------------------------------- | -------------- |
| **Blueprint**       | Versioned, publishable description of a complete setup                  | Admin          |
| **Slot**            | One device requirement — a device that sealed template X targets        | Admin          |
| **Param**           | A named, tunable number/string the setup exposes (`humidity.min`)       | Admin declares |
| **Phase**           | An ordered lifecycle step that sets values for params; may auto-advance | Admin          |
| **Template entity** | A scene / rule / pipeline defined against slots + params                | Admin          |
| **Instance**        | A user's live copy: bindings, overrides, current phase                  | User           |
| **Area**            | "These devices belong together." Standalone — usable without blueprints | User           |
| **Override**        | A user's own value for a param, beating the phase                       | User           |
| **Drift**           | A derived entity the user edited; reconcile leaves it alone             | Derived        |

**Area is deliberately not blueprint-owned.** A user who wires devices by hand has the same need
for a sectioned dashboard and unambiguous notifications as one who derived. Areas ship first, on
their own, and a derive simply creates one.

---

## 3. The parameter mechanism

Three actors want to write the same rule row:

- **reconcile** — the admin improved the blueprint, push the change down
- **phase advance** — the setup moved from Seedling to Mature, retune it
- **the user** — "40% is too dry for me, make it 50"

The shelved design let all three write the row and resolved conflicts by wiping everything on
re-derive. That is why it was unmergeable.

**Instead: the row holds a reference.**

```
UserRuleCondition.threshold_value = "@phase.humidity.min"
```

Resolution happens at evaluation time, with precedence:

```
user override (this phase)  →  user override (all phases)  →  current phase  →  blueprint default
```

> **Amended 2026-07-31 (F10.11).** The original design had a single, instance-wide override layer,
> so correcting one phase and opting out of the schedule entirely were the same act — the value won
> in every phase. Overrides now carry a `phase_key` (`''` = all phases), and the more specific row
> wins. Both layers remain **per instance**: two setups derived from one blueprint tune
> independently, and neither can write the shared template.

| Actor         | What it writes                                                         | What it never touches |
| ------------- | ---------------------------------------------------------------------- | --------------------- |
| Reconcile     | entity **structure** (exists? wired to which action?)                  | values, overrides     |
| Phase change  | the two phase columns + that phase's `BlueprintInstancePhaseState` row | any rule/pipeline row |
| User override | a `BlueprintParamOverride` row                                         | the rule row itself   |

They are physically incapable of clobbering each other, because they write to disjoint places.

> **Amended 2026-07-31 (F10.13).** Deriving a setup no longer starts it. A `lifecycle_state`
> (`not_started` / `running` / `stopped`) is set by the user, who also says which phase the real
> process is in and how far into it — because binding a board carries none of that. The gate is
> `isAutomationLive` in `@lattice/params`, and it sits in front of the phase-scope gate: while a
> setup is not running **nothing it derived acts**, emergency rules included. Parking works by
> nulling `phase_started_at`, so one column stops the clock for both the cron and the UI.

> **Amended 2026-07-31 (F10.12).** A phase change used to be literally one column write. It is now
> three rows in one transaction — `current_phase_id` + `phase_started_at`, the leaving phase's time
> bank, and the entering phase's — because re-stamping `phase_started_at` on every move meant a
> rolled-back phase restarted from zero, with nowhere to record the time already spent in it.
> Leaving a phase banks its run; entering one either spends that bank (`resume`), discards it
> (`reset`) or takes a value the user names (`at`). Auto-advance always resets, so the clock alone
> can never spend a bank. The invariant the row above is really asserting is unchanged and is the
> one that matters: **no rule, scene or pipeline row is written by a phase change.**

**Reference grammar** (validated on write, resolved on read):

| Form             | Resolves to                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `@param.<key>`   | all-phases override → blueprint default (ignores everything phase-scoped) |
| `@phase.<key>`   | phase override → all-phases override → phase target → blueprint default   |
| literal (`"40"`) | itself — untouched, what every existing rule uses today                   |

**Where it plugs in.** The resolver is one step in front of an existing line —
`services/automation-worker/src/services/rules.engine.ts:142`:

```ts
// today
const target = parseFloat(condition.threshold_value);

// after
const target = parseFloat(await resolveParam(condition.threshold_value, ctx));
```

`ctx` is loaded once per rule from the rule's `blueprint_instance_id` (null ⇒ literals only, zero
cost for every non-blueprint rule on the platform).

It lives in a new tiny `packages/params` so `automation-worker`, `services/api` validation, and
`ml-router` share one implementation and cannot disagree.

**Resolution runs in two places, by design:**

| Site                    | Service                                   | What it resolves                                                                                             | When                |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------- |
| Rule / scene evaluation | `automation-worker` `rules.engine.ts:142` | `threshold_value`, action `target_state`                                                                     | on every evaluation |
| Pipeline run            | `ml-router`                               | sensor `min_value`/`max_value` (`pipeline/stages/enrich.ts`), prompt text (`pipeline/prompt.ts buildPrompt`) | at run time         |

The pipeline site is what makes phase context reach the LLM: a prompt of `"This setup is in its
@phase.name phase. @phase.context_notes …"` is resolved against the instance's current phase when
the run fires, so advancing the phase changes what the model is told with nothing rewritten. Both
sites load the same `ctx` (overrides + current-phase targets + defaults) from the entity's
`blueprint_instance_id`; a null instance id means literals only and zero added cost — every
existing rule and pipeline on the platform is unaffected.

---

## 4. Schema

Additive only. `prisma/SCHEMA.md` ERD updated in the same change (hard rule); real migration.

### 4.1 Areas — Tier 4, beside `UserActionGroup`

```prisma
// "These devices belong together." Independent of blueprints — a user can create one by hand.
// A blueprint derive creates one and fills it. Powers dashboard sectioning, notification
// context, and AI context scoping.
model Area {
  id         Int      @id @default(autoincrement())
  user_id    Int
  name       String   @db.VarChar(255)
  sort_order Int      @default(0)
  created_at DateTime @default(now()) @db.Timestamp(6)
  updated_at DateTime @default(now()) @db.Timestamp(6)

  user      User                @relation(fields: [user_id], references: [id], onDelete: Cascade)
  devices   UserDevice[]
  scenes    Scene[]
  rules     UserRule[]
  pipelines Pipeline[]
  instances BlueprintInstance[]

  @@unique([user_id, name])
  @@index([user_id, sort_order])
  @@map("areas")
}
```

Added to existing models (all nullable, all `SetNull` — an area delete never deletes a device or
an automation):

```prisma
model UserDevice { area_id Int?   /* → Area, SetNull */ }
model Scene      { area_id Int?   /* → Area, SetNull */ }
model UserRule   { area_id Int?   /* → Area, SetNull */ }
model Pipeline   { area_id Int?   /* → Area, SetNull */ }
```

### 4.2 Blueprint definition — admin-owned

```prisma
model Blueprint {
  id            Int      @id @default(autoincrement())
  key           String   @unique @db.VarChar(100)
  name          String   @db.VarChar(255)
  description   String?
  version       Int      @default(1)   // bumped on publish, NOT on every edit
  status        String   @default("draft") @db.VarChar(20)  // draft | published
  context_notes String?                 // free text for the AI (F11)
  created_at    DateTime @default(now()) @db.Timestamp(6)
  updated_at    DateTime @default(now()) @db.Timestamp(6)

  slots     BlueprintSlot[]
  params    BlueprintParam[]
  phases    BlueprintPhase[]
  scenes    BlueprintSceneTemplate[]
  rules     BlueprintRuleTemplate[]
  pipelines BlueprintPipelineTemplate[]
  instances BlueprintInstance[]

  @@map("blueprints")
}

// One device requirement: a device that a released sealed template targets. The existing
// version-range logic in sealed-templates.service.ts decides what qualifies. Non-sealed,
// hand-configured devices are intentionally out of scope — a blueprint orchestrates
// factory-defined device types, nothing else.
model BlueprintSlot {
  id                 Int     @id @default(autoincrement())
  blueprint_id       Int
  key                String  @db.VarChar(64)   // referenced by templates + bindings
  label              String  @db.VarChar(255)
  required           Boolean @default(true)
  min_count          Int     @default(1)
  max_count          Int     @default(1)
  sealed_template_id Int                        // required — the only match path

  blueprint       Blueprint      @relation(fields: [blueprint_id], references: [id], onDelete: Cascade)
  sealed_template SealedTemplate @relation(fields: [sealed_template_id], references: [id], onDelete: Restrict)

  @@unique([blueprint_id, key])
  @@map("blueprint_slots")
}

// The declared tuning surface. Everything a phase can set and a user can override must be
// declared here first — so the builder UI, validation, and the instance page all work off one list.
model BlueprintParam {
  id            Int     @id @default(autoincrement())
  blueprint_id  Int
  key           String  @db.VarChar(64)    // "humidity.min" — what @param./@phase. resolves
  label         String  @db.VarChar(255)
  default_value String  @db.VarChar(100)
  unit          String? @db.VarChar(20)
  user_tunable  Boolean @default(true)     // false ⇒ phase-driven only, no override UI

  blueprint Blueprint @relation(fields: [blueprint_id], references: [id], onDelete: Cascade)

  @@unique([blueprint_id, key])
  @@map("blueprint_params")
}

model BlueprintPhase {
  id             Int     @id @default(autoincrement())
  blueprint_id   Int
  key            String  @db.VarChar(64)
  name           String  @db.VarChar(255)
  ordinal        Int
  duration_value Int?
  duration_unit  String? @db.VarChar(10)   // hours | days | weeks
  auto_advance   Boolean @default(false)   // elapsed duration advances automatically
  context_notes  String?

  blueprint Blueprint              @relation(fields: [blueprint_id], references: [id], onDelete: Cascade)
  targets   BlueprintPhaseTarget[]
  instances BlueprintInstance[]

  @@unique([blueprint_id, key])
  @@index([blueprint_id, ordinal])
  @@map("blueprint_phases")
}

// What this phase sets a param to. Absent ⇒ the param's default applies.
model BlueprintPhaseTarget {
  id        Int    @id @default(autoincrement())
  phase_id  Int
  param_key String @db.VarChar(64)
  value     String @db.VarChar(100)

  phase BlueprintPhase @relation(fields: [phase_id], references: [id], onDelete: Cascade)

  @@unique([phase_id, param_key])
  @@map("blueprint_phase_targets")
}
```

### 4.3 Template entities

Each mirrors its concrete counterpart, with two substitutions: `user_device_action_id` becomes
`(slot_key, capability_key)`, and value fields accept `@param.` / `@phase.` references. Each
carries a stable `key` — **this is the reconcile identity**, the thing that says "this derived
rule came from that template".

```prisma
model BlueprintRuleTemplate {
  id                 Int     @id @default(autoincrement())
  blueprint_id       Int
  key                String  @db.VarChar(64)   // reconcile identity
  name               String  @db.VarChar(255)
  is_emergency       Boolean @default(false)
  condition_operator String  @default("AND") @db.VarChar(3)
  cooldown_seconds   Int     @default(60)

  blueprint  Blueprint                        @relation(fields: [blueprint_id], references: [id], onDelete: Cascade)
  conditions BlueprintRuleTemplateCondition[]
  actions    BlueprintRuleTemplateAction[]

  @@unique([blueprint_id, key])
  @@map("blueprint_rule_templates")
}

model BlueprintRuleTemplateCondition {
  id              Int     @id @default(autoincrement())
  template_id     Int
  condition_type  String  @db.VarChar(20)
  slot_key        String? @db.VarChar(64)    // ← replaces user_device_action_id
  capability_key  String? @db.VarChar(64)    // ←
  operator        String? @db.VarChar(5)
  threshold_value String? @db.VarChar(100)   // literal OR "@phase.humidity.min"
  status_value    String? @db.VarChar(20)
  schedule_time   String? @db.VarChar(5)
  schedule_days   Int[]

  template BlueprintRuleTemplate @relation(fields: [template_id], references: [id], onDelete: Cascade)

  @@map("blueprint_rule_template_conditions")
}

model BlueprintRuleTemplateAction {
  id             Int    @id @default(autoincrement())
  template_id    Int
  slot_key       String @db.VarChar(64)
  capability_key String @db.VarChar(64)
  target_state   String @db.VarChar(255)   // literal OR "@param.pump_speed"
  delay_seconds  Int    @default(0)

  template BlueprintRuleTemplate @relation(fields: [template_id], references: [id], onDelete: Cascade)

  @@map("blueprint_rule_template_actions")
}
```

`BlueprintSceneTemplate(+Member)` and `BlueprintPipelineTemplate(+Sensor,+Stage,+Trigger)` follow
exactly the same pattern against `Scene`/`SceneMember` and `Pipeline`/`PipelineSensor`/
`PipelineStage`/`PipelineTrigger`. Pipeline stage `config` JSON (including `prompt_template`)
accepts references too, so a prompt can say _"the current phase is @phase.name"_.

### 4.4 Instance — user-owned

```prisma
model BlueprintInstance {
  id                Int       @id @default(autoincrement())
  user_id           Int
  blueprint_id      Int
  blueprint_version Int       // version this was derived/reconciled from
  area_id           Int
  name              String    @db.VarChar(255)
  current_phase_id  Int?
  phase_started_at  DateTime? @db.Timestamp(6)
  created_at        DateTime  @default(now()) @db.Timestamp(6)
  updated_at        DateTime  @default(now()) @db.Timestamp(6)

  user          User                    @relation(fields: [user_id], references: [id], onDelete: Cascade)
  blueprint     Blueprint               @relation(fields: [blueprint_id], references: [id], onDelete: Restrict)
  area          Area                    @relation(fields: [area_id], references: [id], onDelete: Cascade)
  current_phase BlueprintPhase?         @relation(fields: [current_phase_id], references: [id], onDelete: SetNull)
  bindings      BlueprintSlotBinding[]
  overrides     BlueprintParamOverride[]
  scenes        Scene[]
  rules         UserRule[]
  pipelines     Pipeline[]

  @@unique([user_id, name])
  @@map("blueprint_instances")
}

model BlueprintSlotBinding {
  id             Int     @id @default(autoincrement())
  instance_id    Int
  slot_key       String  @db.VarChar(64)   // plain string — survives template edits
  user_device_id Int
  auto_bound     Boolean @default(false)   // bound with no user input

  instance    BlueprintInstance @relation(fields: [instance_id], references: [id], onDelete: Cascade)
  user_device UserDevice        @relation(fields: [user_device_id], references: [id], onDelete: Cascade)

  @@unique([instance_id, slot_key, user_device_id])
  @@map("blueprint_slot_bindings")
}

// The user's own tuning. Beats the phase. Reconcile never touches this table.
model BlueprintParamOverride {
  id          Int    @id @default(autoincrement())
  instance_id Int
  param_key   String @db.VarChar(64)
  value       String @db.VarChar(100)

  instance BlueprintInstance @relation(fields: [instance_id], references: [id], onDelete: Cascade)

  @@unique([instance_id, param_key])
  @@map("blueprint_param_overrides")
}
```

### 4.5 Provenance on derived entities

`Scene`, `UserRule`, and `Pipeline` each gain three columns:

```prisma
blueprint_instance_id Int?                       // → BlueprintInstance, SetNull
blueprint_key         String? @db.VarChar(64)    // which template made it — reconcile identity
user_modified         Boolean @default(false)    // user edited it ⇒ reconcile skips it
```

`user_modified` is set by the ordinary update paths in `rules.service.ts` / `scenes.service.ts` /
`pipelines.service.ts` whenever the row has a `blueprint_instance_id`. No new API needed — editing
a derived rule through the normal editor marks it, automatically.

---

## Flow A — admin authors a blueprint

Authored in the admin builder UI (built last); equivalently importable as JSON via F12.1. The
document below is the whole blueprint.

```json
{
  "key": "reservoir_setup",
  "name": "Reservoir Setup",
  "description": "Tank level monitoring with automatic top-up and environment tracking.",
  "context_notes": "A closed-loop water reservoir. The pump refills the tank when level drops. Environment readings matter more as the cycle progresses.",

  "slots": [
    { "key": "tank", "label": "Tank manager", "sealed_template_id": 3, "required": true },
    { "key": "env", "label": "Environment sensor", "sealed_template_id": 8, "required": true },
    { "key": "pump", "label": "Pump outlet", "sealed_template_id": 5, "required": true }
  ],

  "params": [
    { "key": "tank.min_level", "label": "Refill below", "default_value": "20", "unit": "%" },
    { "key": "humidity.min", "label": "Humidity floor", "default_value": "40", "unit": "%" },
    { "key": "humidity.max", "label": "Humidity ceil", "default_value": "70", "unit": "%" }
  ],

  "phases": [
    {
      "key": "seedling",
      "name": "Seedling",
      "ordinal": 0,
      "duration_value": 2,
      "duration_unit": "weeks",
      "auto_advance": true,
      "context_notes": "Delicate stage — keep humidity high and interventions gentle.",
      "targets": [
        { "param_key": "humidity.min", "value": "60" },
        { "param_key": "humidity.max", "value": "80" }
      ]
    },
    {
      "key": "mature",
      "name": "Mature",
      "ordinal": 1,
      "auto_advance": false,
      "targets": [
        { "param_key": "humidity.min", "value": "40" },
        { "param_key": "humidity.max", "value": "60" }
      ]
    }
  ],

  "rules": [
    {
      "key": "refill_tank",
      "name": "Refill tank",
      "cooldown_seconds": 300,
      "conditions": [
        {
          "condition_type": "threshold",
          "slot_key": "tank",
          "capability_key": "water_level",
          "operator": "<",
          "threshold_value": "@param.tank.min_level"
        }
      ],
      "actions": [
        { "slot_key": "pump", "capability_key": "outlet", "target_state": "ON", "delay_seconds": 0 }
      ]
    },

    {
      "key": "humidity_low",
      "name": "Humidity below target",
      "is_emergency": false,
      "conditions": [
        {
          "condition_type": "threshold",
          "slot_key": "env",
          "capability_key": "humidity",
          "operator": "<",
          "threshold_value": "@phase.humidity.min"
        }
      ],
      "actions": []
    }
  ],

  "scenes": [
    {
      "key": "shutdown",
      "name": "Shut down",
      "members": [
        {
          "slot_key": "pump",
          "capability_key": "outlet",
          "target_state": "OFF",
          "sort_order": 0,
          "delay_seconds": 0
        }
      ]
    }
  ],

  "pipelines": [
    {
      "key": "daily_review",
      "name": "Daily review",
      "sensors": [
        {
          "slot_key": "env",
          "capability_key": "humidity",
          "group_name": "environment",
          "description": "Ambient humidity",
          "compression": "average",
          "window_minutes": 1440,
          "min_value": "@phase.humidity.min",
          "max_value": "@phase.humidity.max"
        }
      ],
      "stages": [
        { "ordinal": 0, "kind": "enrich" },
        {
          "ordinal": 1,
          "kind": "infer",
          "ml_model_id": 2,
          "config": {
            "prompt_template": "This setup is in its @phase.name phase. @phase.context_notes Assess the readings."
          }
        }
      ],
      "triggers": [{ "trigger_type": "schedule", "schedule_cron": "0 6 * * *" }]
    }
  ]
}
```

**Publish** (`POST /api/admin/blueprints/:id/publish`) validates and bumps `version` → 1:

- every `slot_key` used by a template exists
- every `@param.x` / `@phase.x` reference resolves to a declared `BlueprintParam`
- every `(slot_key, capability_key)` pair is actually offered by that slot's sealed template
  (checked against the template's entries)
- referenced sealed templates are `released`
- ordinals unique; `infer` stages have a model; existing `validateStageOrdering` applies

> Version bumps on **publish**, not on every edit — so `blueprint_version` on an instance always
> names a real published revision. (The shelved build bumped on edit; that was review finding #4.)

---

## Flow B — user derives an instance

The user has three provisioned devices and taps **Reservoir Setup** in the gallery.

**B1 — candidate resolution.** For each slot, the derive service asks for eligible devices:

| Slot   | Match path                       | Candidates                       | Result                      |
| ------ | -------------------------------- | -------------------------------- | --------------------------- |
| `tank` | sealed template 3, version range | `UserDevice 41`                  | **auto-bind** (exactly one) |
| `pump` | sealed template 5, version range | `UserDevice 42`, `UserDevice 43` | **ask the user**            |
| `env`  | sealed template 8, version range | `UserDevice 44`                  | **auto-bind**               |

Range matching reuses the existing logic behind
`sealed-templates.service.ts:203 countMatchingDevices` — `device_type` equal and
`version_min <= version <= version_max`. Nothing new.

**B2 — the request.** Only the ambiguous slot needs an answer:

```json
POST /api/blueprint-instances
{
  "blueprint_id": 7,
  "name": "Main reservoir",
  "area_name": "Greenhouse A",
  "bindings": [ { "slot_key": "pump", "user_device_ids": [42] } ]
}
```

Auto-bound slots are re-resolved and re-validated **server-side** — a client binding is never
trusted on its own, and auto-binding is never taken on faith from the request.

**B3 — one transaction.** Rows created:

```
areas                     id=9   name="Greenhouse A"
blueprint_instances       id=12  blueprint_id=7  blueprint_version=1  area_id=9
                                 name="Main reservoir"
                                 current_phase_id=<seedling>  phase_started_at=now()

blueprint_slot_bindings   instance=12 slot="tank" device=41 auto_bound=true
                          instance=12 slot="pump" device=42 auto_bound=false
                          instance=12 slot="env"  device=44 auto_bound=true

user_devices              41,42,44  →  area_id=9
```

**B4 — device config, not reimplemented.** For each bound device whose slot names a sealed
template, call the existing
`device-gateway/src/services/sealed-materialization.service.ts:materializeForUserDevice()`.
It upserts `user_device_actions` by `mqtt_action_name`, replaces pins and behaviors, and
**deprecates rather than deletes** anything no longer in the template — so any pre-existing rule
or scene binding survives. Config reload is the existing `restart` dispatch (never `reprovision` —
that wipes credentials; see commit `0fa1227`).

After this, slot → action resolution is possible:

```
slot "tank" + capability "water_level"  →  user_device_action 501
slot "pump" + capability "outlet"       →  user_device_action 502
slot "env"  + capability "humidity"     →  user_device_action 503
```

**B5 — materialize the templates.** Through the existing
`rules.service.ts` / `scenes.service.ts` / `pipelines.service.ts` create paths, so their
validation applies. Slot references resolve to action ids; **`@` references are copied through
verbatim**:

```
user_rules   id=88  name="Refill tank"  area_id=9
                    blueprint_instance_id=12  blueprint_key="refill_tank"  user_modified=false
  conditions       user_device_action_id=501  operator="<"
                   threshold_value="@param.tank.min_level"      ← stored as a reference
  actions          user_device_action_id=502  target_state="ON"

user_rules   id=89  name="Humidity below target"  blueprint_key="humidity_low"
  conditions       user_device_action_id=503  operator="<"
                   threshold_value="@phase.humidity.min"        ← phase-driven

scenes       id=31  name="Shut down"  area_id=9  blueprint_key="shutdown"
  members          user_device_action_id=502  target_state="OFF"

pipelines    id=17  name="Daily review"  area_id=9  blueprint_key="daily_review"
  sensors          user_device_action_id=503
                   min_value="@phase.humidity.min"  max_value="@phase.humidity.max"
```

A template member whose slot has no bound device with that capability is **skipped, not fatal** —
an optional slot left empty shouldn't fail the whole derive.

**Errors:** `409` duplicate instance name · `400` blueprint not published · `400` required slot
unsatisfiable, naming the slot · `400` client-supplied device fails server re-validation.

---

## Flow C — a derived rule fires

Rule 89 — `humidity < @phase.humidity.min`. Instance 12 is in **Seedling**, no overrides.

1. Device 44 reports humidity `52`. `digest-service` writes state and publishes `RULES_EVALUATE`.
2. `automation-worker` loads rule 89. It has `blueprint_instance_id = 12`, so it loads the
   resolution context **once**:
   ```
   overrides    = {}                                  (blueprint_param_overrides, instance 12)
   phaseTargets = { humidity.min: "60", humidity.max: "80" }   (Seedling)
   defaults     = { humidity.min: "40", humidity.max: "70", tank.min_level: "20" }
   ```
3. `resolveParam("@phase.humidity.min", ctx)` → override? no → phase? **`"60"`** → done.
4. `compare(52, "<", 60)` → **true**. Rule fires.

A rule with `blueprint_instance_id = null` skips step 2 entirely and behaves exactly as today —
every existing rule on the platform is unaffected and costs nothing extra.

**Unresolvable reference** (param deleted from the blueprint, say): resolution returns null, the
condition evaluates false, and a warning is logged with the rule id and the reference. It fails
closed — it never fires on garbage.

---

## Flow D — a phase advances

Seedling has `duration_value: 2, duration_unit: "weeks", auto_advance: true`.

`automation-worker` already runs a 10s cron for schedule conditions
(`cron.schedule('*/10 * * * * *', …)` in `src/index.ts`). A second pass rides it — cheap, because
it only queries instances whose current phase auto-advances:

```
for each BlueprintInstance where current_phase.auto_advance
    and phase_started_at + duration <= now():
        next = phase with ordinal + 1        (none ⇒ stay, log, done)
        UPDATE blueprint_instances
           SET current_phase_id = next.id, phase_started_at = now()
        publish NOTIFICATION_SEND { eventType: "phase_advanced",
                                    context: { area_id, area_name } }
```

**That is the entire retune.** One column. Zero writes to rules, scenes, or pipelines.

Immediately afterward, the exact same rule 89 evaluates differently:

|                                   | Seedling  | Mature        |
| --------------------------------- | --------- | ------------- |
| `@phase.humidity.min` resolves to | `60`      | `40`          |
| humidity `52`                     | **fires** | does not fire |

The pipeline prompt changes with it — `@phase.name` and `@phase.context_notes` resolve at prompt
build time, so the LLM is told which stage it's assessing without anything being rewritten.

A user can also advance manually: `PATCH /api/blueprint-instances/12/phase { "phase_key": "mature" }`.

---

## Flow E — user overrides a parameter

The user thinks 40% is too dry and sets the humidity floor to 50 on the instance page.

```json
PUT /api/blueprint-instances/12/params/humidity.min   { "value": "50" }
```

```
blueprint_param_overrides   instance=12  param_key="humidity.min"  value="50"
```

With no `phase_key`, that is the all-phases scope, so it wins in **every** phase:

| Phase    | Phase target | Override (all) | Resolves to |
| -------- | ------------ | -------------- | ----------- |
| Seedling | 60           | 50             | **50**      |
| Mature   | 40           | 50             | **50**      |

To correct one phase instead, the same call carries a scope — `{ "value": "45", "phase_key": "mature" }`:

```
blueprint_param_overrides   instance=12  param_key="humidity.min"  phase_key="mature"  value="45"
```

| Phase    | Phase target | Override (all) | Override (phase) | Resolves to |
| -------- | ------------ | -------------- | ---------------- | ----------- |
| Seedling | 60           | 50             | —                | **50**      |
| Mature   | 40           | 50             | 45               | **45**      |

The instance page shows every phase resolved at once, so the user can tune a phase they have not
reached yet — advancing is no longer the way to find out what a phase is set to. Each scope has its
own **Reset**, which deletes only that row; clearing a phase's value never wipes the all-phases one.
No rule row was ever touched, in any direction.

**Two kinds of user change, deliberately different:**

| The user…                                    | Writes                            | Reconcile behavior                                    |
| -------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| tunes a **param** on the instance page       | an override row                   | still reconciles the entity — values were never in it |
| edits the **rule itself** in the rule editor | `user_modified = true` on rule 88 | skips that entity entirely, shows it as drifted       |

The first is the encouraged path and costs nothing. The second is the escape hatch, and it opts
that one entity out of future updates — surfaced, not silent.

---

## Flow F — admin releases v2, instances reconcile

The admin improves the blueprint: adds a cooldown to `refill_tank`, adds a new rule
`tank_critical`, drops the `shutdown` scene. Publish → `version = 2`.

Meanwhile the user had edited rule 88 ("Refill tank") in the rule editor, so it carries
`user_modified = true`.

`blueprints-reconcile.service.ts` runs per instance, matching derived rows to templates by
`blueprint_key`:

| Template key    | Derived row          | `user_modified` | Action                                          |
| --------------- | -------------------- | --------------- | ----------------------------------------------- |
| `refill_tank`   | rule 88              | **true**        | **skip** — leave alone, list as drifted         |
| `humidity_low`  | rule 89              | false           | update structure (name, cooldown, wiring)       |
| `tank_critical` | —                    | —               | **create** rule 90, wired via existing bindings |
| `shutdown`      | scene 31             | false           | **disable, don't delete** (`enabled = false`)   |
| —               | rule 77 (user's own) | n/a             | **untouched** — no `blueprint_key`, not ours    |

Then `blueprint_instances.blueprint_version = 2`.

**Invariants that make this safe:**

- Reconcile writes **structure only**. It never reads or writes `blueprint_param_overrides`, so
  the user's `humidity.min = 50` survives every release, forever.
- It never **deletes** a derived entity — removal from a template disables it, so history,
  `PipelineRun` rows, and any manual reference survive.
- It never touches a row without a `blueprint_key` matching this blueprint — a user's own
  automations are invisible to it.

The instance page after reconcile:

```
Reservoir Setup — Main reservoir            Blueprint v2 · Phase: Mature (day 3)

  Refill tank            ⚠ modified — differs from blueprint     [Reset to blueprint]
  Humidity below target  ✓ up to date
  Tank critical          ✓ new in v2
  Shut down              ⊘ removed in v2 (disabled)              [Delete]

  Parameters
    Refill below    20 %   (blueprint default)
    Humidity floor  50 %   ⚠ overridden — phase says 40          [Reset]
```

**Reset to blueprint** on rule 88 clears `user_modified` and reconciles that single entity.

---

## Flow G — a notification carries its area

Today a rule firing sends `"Rule \"Humidity below target\" was triggered."` — with two setups, the
user can't tell which one is talking.

The payload contract is extended **in `@lattice/queue`** (hard rule — the shelved branch edited
only `templates.ts`, no producer ever set the field, and the feature was inert):

```ts
// packages/queue/src/types.ts
export interface NotificationSendPayload {
  userId: string;
  eventType: string;
  data: Record<string, unknown>;
  dedupeKey?: string;
  channels?: string[];
  context?: { area_id: number; area_name: string }; // new
}
```

…plus the matching zod field in `packages/queue/src/schemas.ts` (`publish()` throws on contract
violation outside production, so this must land in both).

Producer — `rules.engine.ts:notifyRuleFired`, populated from `rule.area_id`:

```ts
publish(ch, RK.NOTIFICATION_SEND, {
  userId: String(userId),
  eventType: rule.is_emergency ? 'emergency' : 'rule_fired',
  data: { ruleName: rule.name, title: rule.name, message: `Rule "${rule.name}" was triggered.` },
  dedupeKey: `rule:${rule.id}`,
  context: area ? { area_id: area.id, area_name: area.name } : undefined,
});
```

Consumer — `notification-service/src/delivery/templates.ts` prefixes the **title** (the body is
often the rule's own message):

```
Greenhouse A · Humidity below target
Rule "Humidity below target" was triggered.
```

`area_id` lands in `NotificationHistory.data`, so the in-app inbox can filter by area.

Because the context is on **Area** and not on the instance, a hand-built rule in a hand-made area
gets the same treatment. That is the whole reason Area is separate.

---

## 12. What this does NOT do

Stated so nobody has to rediscover it:

- **No user-to-user blueprint sharing.** Authoring is admin-only. Export/import is F12's problem.
- **No non-sealed slots.** Every slot points at a sealed template. A blueprint orchestrates
  factory-defined device types, not hand-configured generic devices.
- **No `role_tag`, no firmware change.** Binding goes through sealed templates. `DEVICE_ROLE_STR`,
  the manifest `role` field, and the catalog column are all dropped from the design.
- **No re-derive.** Reconcile replaces it. There is no "wipe and rebuild" path.
- **No device locking.** A blueprint-bound device is not read-only; sealed _devices_ are already
  read-only in the device page (`isSealed`), which is a property of the device, not the blueprint.
- **No shaped dashboard skins.** Areas give sectioning. Per-blueprint visual layouts stay deferred.
- **No monitor windows / quiet hours.** Dropped — it belongs to notification preferences, not here.

### Inherited debt (real, not blocking)

- **Delays are in-process `setTimeout`** — `scenes.service.ts:execute` (`.unref()`'d) and
  `rules.engine.ts:executeRule` (not). An API restart drops pending members. Already on master via
  F10.5; derived scenes inherit it.
- **Two dispatch paths** — scenes and pipeline `command_exec` use `ACTION_REQUESTED` (digest
  validates values, tracks pending, echoes over socket); rules use `ACTION_DISPATCH` with none of
  that. Derived rules get the weaker path.
- **`rules.service.ts` doesn't check action ownership** on write, unlike scenes and pipelines —
  and derive writes rules through it. **Fix this inside F10**; it's a few lines and derive makes
  it programmatically reachable.

---

## 13. Build order

Each step is verifiable alone. The builder UI is last, deliberately — it was the thinnest part of
the shelved branch and blocking the vertical slice on it is how this stalled the first time.

| #   | Step                                                                                                   | Verify                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Areas** — schema, service, routes, dashboard sectioning, device assignment                           | two areas in the UI, sim devices assigned, dashboard sections                                                              |
| 2   | **`packages/params`** + resolver wired into `rules.engine` **and** ml-router (`enrich`, `buildPrompt`) | unit tests; a rule with `@param.x` fires against device-sim; a pipeline prompt with `@phase.name` renders the phase        |
| 3   | **Blueprint schema** + one vertical seeded as JSON (no builder UI)                                     | migration clean, ERD updated, publish validation rejects a bad ref                                                         |
| 4   | **Derive service** — auto-bind, area, sealed materialization, templates                                | derive via curl; derived rule fires; scene runs                                                                            |
| 5   | **Phases** — targets, precedence, auto-advance cron                                                    | advance a phase: same rule fires at a new threshold and the pipeline prompt names the new phase, zero rule/pipeline writes |
| 6   | **Overrides + drift + reconcile**                                                                      | release v2: unmodified updates, edited one is skipped and flagged, reset restores                                          |
| 7   | **Notifications + area context** through `@lattice/queue`                                              | tagged rule fires, notification title names the area                                                                       |
| 8   | **Gallery + derive wizard + instance page**                                                            | full derive from the browser                                                                                               |
| 9   | **Admin builder UI**                                                                                   | build, publish, and derive a blueprint entirely in the UI                                                                  |

### Verification setup

```bash
npm run build:libs && npm run dev:up
npm run catalog:seed                  # catalog + sealed templates + the seeded blueprint
cd backoffice && ng serve             # localhost:4200 exactly — the CORS allowlist is a literal match
```

Drive it in a real browser with a device-sim fleet matching the slots — build+lint green is not
verification. Then `npm test`, `npm run lint`, `npm run typecheck`.

### Compliance

- [ ] Generic naming in code/seeds/tests; domain words only as admin-typed runtime data
- [ ] `prisma/SCHEMA.md` ERD updated with every schema change; real migrations, no `db push`
- [ ] Notification `context` field goes through `@lattice/queue` types **and** zod schemas
- [ ] Routes stay thin; derive/reconcile/matcher logic in services
- [ ] No new routing key for scenes (existing `ACTION_REQUESTED` fan-out)
- [ ] Nothing committed or pushed without explicit go-ahead
