# Manual test plan — F10 Blueprints

A walkthrough of the whole feature against the dev stack. Roughly 30–40 minutes end to end.
Automated coverage lives in `tests/unit/blueprints.*` and `tests/e2e/blueprints.e2e.test.ts`; this
list is for the things a person should look at.

## Before you start

The dev stack is already up and seeded. If you need to bring it back:

```bash
npm run dev:up                        # api :3100, gateway :3004, sim fleet
cd backoffice && npx ng serve         # http://localhost:4200 — exactly this origin, CORS is literal
```

Log in as the `OWNER_USERNAME` / `OWNER_PASSWORD` from `.env` (admin).

**What is already set up for you**

| Thing                                                     | State                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Sealed templates `Tank Monitor Board`, `Socket Board 2ch` | released                                                                 |
| Blueprint `Monitored Tank Loop` (`monitored_tank`)        | published, **v2**                                                        |
| Sim devices                                               | 2 × `HYDRO_FARM_WATER_TANK_MANAGER`, 2 × `MULTI_SOCKET_8_CH`, all online |
| Derived setups                                            | **none** — test 1 creates the first                                      |

Two of each sealed type is deliberate: every slot has 2 candidates, so the wizard's device picker
is exercised rather than silently auto-binding.

**Watching the logs.** Every service in `compose.dev.yaml` now runs at `LOG_LEVEL=debug`. The
useful ones:

```bash
docker logs -f api               | grep -iE "derive|reconcile|instance|override|phase"
docker logs -f automation-worker | grep -iE "resolved|threshold|phase cron|rule fired"
docker logs -f ml-router         | grep -iE "prompt|expected|parameter context"
```

Set `LOG_LEVEL=info` in `.env` and `npm run dev:up` again if it gets noisy.

---

## 1 · Derive a setup (F10.3)

1. Sidebar → **Set up**. You should see the `Monitored Tank Loop` card, both slots green, footer
   reading **"Ready — 2 choices to make"**.
2. Press **Set up**. The dialog opens with the name pre-filled and a **dropdown per slot** (because
   each has 2 candidates).
3. Name it `Tank Loop A`, pick a tank and a socket board, press **Create setup**.

**Expect:** redirected to the instance page. `api` logs show `derive: starting` → `derive: slot
bound (user choice)` ×2 → `derive: resolving (slot, action_name)…` → `blueprint derived`.

**Also check**

- Sidebar → **Dashboard**: a new **Tank Loop A** area band holding the two devices.
- Sidebar → **Automate**: rules `Refill the tank`, `Stop refilling`, `Possible leak`; a `Loop review`
  pipeline; a `Stop the loop` scene on the dashboard.

### 1b · The failure paths (worth seeing once)

- Derive a **second** setup with the _same name_ → 409, "a setup named … already exists".
- Derive a second setup with a _different_ name using the **other** device pair → succeeds. Note the
  first pair now shows "already in another setup" in the dropdown but is still selectable (sharing a
  controller across two setups is legitimate).

---

## 2 · Parameters and precedence (F10.4)

On the instance page, the **Settings** card. Each row shows the resolved value _and where it came
from_ — that label is the point of the whole design.

| Step                                   | Expect                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Fresh setup, phase **Commissioning**   | `Refill below` = **40** "from this phase"; `Stop filling at` = **95** "from this phase"                                      |
| `Pump on value`                        | shown read-only (`user_tunable: false`) — no input, no restore button                                                        |
| Click the **Steady state** phase       | `Refill below` → **20** "from this phase"; `Stop filling at` → **90** **"blueprint default"** (steady sets no target for it) |
| Type `33` into `Refill below`, tab out | → **33**, "your value", row gets a left accent bar                                                                           |
| Click the **restore** icon on that row | → back to **20**, "from this phase"                                                                                          |

**The load-bearing check:** open **Automate → Refill the tank** while doing the above. Its
threshold stays the literal text `@phase.level.min` throughout. Nothing rewrites the rule — only
`current_phase_id` / an override row changes.

`api` logs: `phase set manually — one column written, no automation rows touched`, and
`override set — its own row, so reconcile can never clobber it`.

---

## 3 · A derived rule actually fires (F10.1)

The tank sim publishes a random level every 5s, so `Refill the tank` fires whenever it dips below
the current threshold.

```bash
docker logs -f automation-worker | grep -E "resolved from a blueprint|threshold condition|rule fired"
```

**Expect** lines like:

```
rule threshold resolved from a blueprint reference   stored=@phase.level.min resolved=40 phase=commissioning
threshold condition evaluated                        current=27.1 op=< target=40 met=true
rule fired                                           rule="Refill the tank" target="ON"
```

`target: "ON"` is `@param.pump.on_state` resolved — not a literal in the rule row. The stopping
side goes through `@param.pump.off_state` for the same reason: a board wired active-low has to be
able to invert _both_ directions, or the safety path keeps energising the pump.

**Then:** switch the setup to **Steady state** (threshold 20) and watch the same rule start
evaluating against `target=20` with no restart and no rule write.

---

## 4 · The LLM prompt retunes with the phase (F10.1b)

`Loop review` is the derived pipeline. Its prompt template and sensor bounds hold `@phase.*`.

1. **Automate → Pipelines → Loop review → Simulate** (dry run). Give the tank a value like `12.5`
   and the socket `off`.
2. `docker logs ml-router --tail 80` and find the `LLM prompt prepared` line.

**Expect** in **Commissioning**:

```
Context: This loop is in its Commissioning phase. The loop was just set up; readings may be
unstable… The tank should stay between 40% and 95%.

Expected ranges (what "normal" means right now …):
{ "tank": { "Tank level": { "min": "40", "max": "95" } } }
```

3. Switch to **Steady state**, run the dry run again → same pipeline, now reads _"its Steady state
   phase"_, the steady notes, and **20% / 90%**.

`pipeline_sensors` is untouched — check if you like:

```bash
docker exec postgres_db psql -U postgres -d postgres -c \
  "SELECT id, min_value, max_value FROM pipeline_sensors WHERE min_value IS NOT NULL;"
```

It still reads `@phase.level.min` / `@phase.level.max`.

> The `Expected ranges` block is new — sensor bounds have been settable since F5 and were never
> sent to the model until now.

---

## 5 · Drift and reconcile (F10.6)

**5a — make an edit.** Automate → `Refill the tank` → edit → rename it and set cooldown `900` →
save.

**Expect:** instance page grows a **"Your edits"** section listing it, with a **Restore** button.

**5b — publish a v2.** Sidebar → Admin → **Blueprints**. Select `Monitored Tank Loop` — it loads
into the form. Make two changes:

- change `Stop refilling`'s **Cooldown (s)** to `120`
- press **Add rule** and build one: give it a key and name, **Add condition** (pick the `tank` slot,
  then its action from the dropdown, operator `<`, and use the `{}` button to insert
  `@phase.level.min` rather than typing a number), then **Add action** (slot `sockets`, an action,
  set to `OFF`)

Press **Save draft** (validates automatically), then **Publish**.

**Expect:**

- toast: _"Published — 1 live setup(s) updated"_
- your edited rule: **unchanged**, still flagged under "Your edits"
- the untouched rule: **updated** to the v2 values
- any new rule: **created**
- the setup's phase is **preserved** (this is the subtle one — phases are deleted and recreated by
  the re-import, and the instance is re-pointed by key)

`api` logs show `reconcile: starting (* = user_modified, will be skipped)` then one line per
decision: `reconcile: rule "refill_tank" → skipped_user_modified`, `… → updated`, `… → created`.

**5c — restore.** Press **Restore** on the drifted entity.

**Expect:** it is rewritten from the template (taking the v2 values it had been skipping) and
disappears from "Your edits".

**5d — removal is never destructive.** In the admin editor, delete a rule from the document, save,
publish. The derived rule is **disabled, not deleted** — find it in Automate with its toggle off.

---

## 6 · The builder and its validation (F10.9)

Worth doing once from scratch: **New blueprint** (the `+`), then build a tiny one — a slot, a
parameter, one phase, one rule — using only the form. Note that:

- **Sealed template** offers only _released_ templates
- a slot lists the actions it provides, read-only — rules pick from those
- the **Action** dropdown is empty until a slot is chosen, then lists exactly that template's
  actions by label and `mqtt_action_name`
- changing a slot **clears** the action beside it
- the `{}` button beside any value inserts a declared parameter as `@phase.<key>`
- an infer stage's prompt gets chips for `@phase.name`, `@phase.context_notes` and every parameter

Then break things on purpose and press **Publish**.

| Break                                          | Expected message                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `"action_name": "nonsense"` on the tank slot   | _…addresses action "nonsense" on slot "tank", which sealed template "Tank Monitor Board" does not provide (it has: water_level)_ |
| `"threshold_value": "@phase.typo"`             | _references an undeclared parameter "typo"_                                                                                      |
| `"slot_key": "nope"`                           | _addresses slot "nope", which is not declared_                                                                                   |
| a slot pointing at a **draft** sealed template | _…which is draft, not released_                                                                                                  |
| break the JSON itself                          | inline _"That isn't valid JSON"_ with the parser message                                                                         |

---

## 7 · Notifications carry the area (F10.7)

Sidebar → **Notifications** after a rule has fired.

**Expect** the title prefixed with the area: **"Tank Loop A · Automation triggered"**. A rule that
belongs to no area is unprefixed.

> `notification-service` must be running (`docker ps | grep notification`). It is in the dev stack.

---

## 8 · Layout check

Worth 2 minutes at 3 widths — desktop, tablet (~800px), phone (~390px):

- **Set up** gallery: cards reflow to one column on phone; long device types ellipsise rather than
  wrapping the slot label.
- **Instance page**: phase track scrolls horizontally rather than squashing; the param rows keep
  their input and restore button on one line.
- **Admin blueprints**: the two panes stack below ~900px; the condition/action rows wrap to
  multiple lines instead of the page scrolling sideways; the action bar stays pinned at the top
  while you scroll a long blueprint.

---

## 9 · Multi-device slots (a slot that binds several devices)

A slot may hold more than one device — one tank with many pumps, say — and every rule/scene/pipeline
action that names it fans out to each bound device.

**Author it** (Admin → the slot editor): tick **"Allow several devices — automations fan out to each
one"**, then set **Fewest / Most** (e.g. 1 and 4). The collapsed slot summary shows `… · 1–4 devices`.
Publish.

**Derive it**: in the wizard, a multi-device slot shows a **multi-select** ("Choose devices") with a
"pick N to M" hint. Pick two boards.

**Expect** after derive:

- the scene/rule that referenced the slot once now has **one member/action per bound device** —
  `GET /api/scenes` shows the scene with two members on two distinct `user_device_action_id`s;
- the derived rule likewise has a condition + action per board;
- the wizard **auto-fills** all matching devices when they fit under the cap (no prompt); more
  candidates than the cap ⇒ you must choose the subset;
- binding a wrong-type device is still refused (_"does not match slot …"_), and binding fewer than
  the minimum / more than the max is rejected.

> The dev fixture's `sockets` slot is a good candidate — the fleet has two `MULTI_SOCKET_8_CH` boards.

---

## 10 · Phase-scoped automations (active only in certain phases)

An automation can be limited to specific phases; empty scope = active in every phase (the default).
The gate is read at evaluation time, so advancing a phase switches automations on/off **without
rewriting a row**.

**Author it** (Admin): on any rule / scene / pipeline, use **"Active in phases"** — a checkbox per
phase, **all ticked by default** (active everywhere). Untick a phase to exclude it; the last ticked
box is locked on (an automation can't be scoped to zero phases). Leaving them all ticked stores an
empty scope, so a phase added in a later version is included automatically. A scoped automation
shows a phase chip on its collapsed row. Publishing an automation scoped to a phase that doesn't
exist is refused (_"…is scoped to phase "x", which is not a declared phase"_).

**Rules / pipelines** (behavioural — needs sim telemetry): scope a threshold rule to
`commissioning` only. While the instance is in `commissioning`, drive the sensor across the
threshold → the rule fires. Advance to `steady` (one column write) and cross it again → it does
**not** fire.

`automation-worker` logs when it skips:

```
docker logs -f automation-worker | grep -iE "not active in the current phase|rule fired"
```

**Scenes** (on-demand): a `steady`-only scene tile is **dimmed** with _"Not available in this
phase"_ while in `commissioning`, and pressing it does nothing; the API refuses it (`409`,
_"not available in the current phase"_). Advance to `steady` → the tile lights up and runs.

---

## 11 · Pipeline trigger cooldown survives a restart (F10 durable cooldown)

A pipeline `sensor_threshold` trigger with a `min_interval_sec` now records `last_fired_at` on the
trigger row (was a Valkey key that reset on restart). Trigger matching runs in **automation-worker**.

Fire a rate-limited pipeline trigger, then `docker restart automation-worker` and drive the sensor
again **inside** the interval → it must **not** re-fire (the durable timestamp still holds). Before,
a restart reset the cooldown and could double-fire.

```bash
docker exec postgres_db psql -U postgres -d postgres \
  -c "select id, min_interval_sec, last_fired_at from pipeline_triggers where last_fired_at is not null;"
```

---

## Known gaps (not bugs — don't report these)

- **Scenes removed from a blueprint are reported, not disabled** — `Scene` has no `enabled` column,
  and a scene only runs when pressed.
- **Delays are in-process `setTimeout`** in scenes and rules — an api restart drops pending delayed
  members. Pre-existing, inherited by derived entities.
- **The e2e suite targets the ephemeral test stack, not the dev stack.** Run it with
  `npm run test:e2e:up && npm test`, not against a running dev stack — the dev fixture's released
  sealed templates collide with the suite's own (`"overlaps an already-released template"`), and its
  SimDevice provisioning expects the test seed.

## Resetting between runs

```bash
docker exec postgres_db psql -U postgres -d postgres \
  -c "DELETE FROM scenes    WHERE blueprint_key IS NOT NULL;" \
  -c "DELETE FROM user_rules WHERE blueprint_key IS NOT NULL;" \
  -c "DELETE FROM pipelines WHERE blueprint_key IS NOT NULL;" \
  -c "DELETE FROM blueprint_instances;" \
  -c "DELETE FROM areas WHERE name LIKE 'Tank Loop%';"
```

Re-import the blueprint if you have edited it beyond repair:

```bash
# from the repo root, with an admin token
curl -s -X POST http://localhost:3100/api/admin/blueprints/import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @prisma/blueprints/monitored_tank.json
```
