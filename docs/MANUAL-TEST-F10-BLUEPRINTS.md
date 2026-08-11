# Manual test plan — F10/F11 Blueprints

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

| Step                                     | Expect                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Fresh setup, phase **Commissioning**     | `Refill below` = **40** "from this phase"; `Stop filling at` = **95** "from this phase"                                      |
| `Pump on value`                          | shown read-only (`user_tunable: false`) — no input, no restore button                                                        |
| Click **Steady state** → **Start fresh** | `Refill below` → **20** "from this phase"; `Stop filling at` → **90** **"blueprint default"** (steady sets no target for it) |
| Type `33` into `Refill below`, tab out   | → **33**, "your value", row gets a left accent bar                                                                           |
| Click the **restore** icon on that row   | → back to **20**, "from this phase"                                                                                          |

**The load-bearing check:** open **Automate → Refill the tank** while doing the above. Its
threshold stays the literal text `@phase.level.min` throughout. Nothing rewrites the rule — only
the phase columns / a bank row / an override row change.

`api` logs: `phase set manually — phase columns + time bank written, no automation rows touched`,
and `override set — its own row, so reconcile can never clobber it`.

---

## 2a · Starting and stopping a setup (F10.13)

Deriving builds a setup; it does not start it. The instance page leads with a lifecycle card.

| Step                                           | Expect                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Right after deriving                           | card reads **Not started**; the phase track is dimmed and every step is unclickable                               |
| **Automate** → the derived rule                | present and enabled, but it never fires — a not-started setup acts on nothing                                     |
| **Dashboard** → the derived scene              | greyed out; running it returns "This scene's setup is not running"                                                |
| Press **Start**                                | dialog asks the phase **and** how far into it — "just starting", "carry on", or a value you name                  |
| Choose Commissioning, "already underway 1 day" | card reads **Running**, the phase track lights up, and Commissioning shows ~1d elapsed                            |
| Run the derived scene again                    | it fires, and the board acks                                                                                      |
| Press **Pause** → confirm                      | card reads **Paused**; the confirm names how many automations are held and says emergencies too                   |
| While paused, watch `automation-worker` logs   | `rule skipped — its setup is not running`                                                                         |
| Press **Continue**                             | defaults to the phase it was parked in, offering to **carry on** from the banked time                             |
| Press the **reset** icon → confirm             | back to **Not started**, every phase's banked time gone — but the devices, tuning and automations all still there |

The load-bearing check here is the **scene**, not the rule: it is unscoped, so the phase gate alone
would never hold it. If it runs while the setup is paused, the lifecycle gate is not doing its job.

**Also check the setups list** (sidebar → _Set up_). Each row carries the state chip, the phase and
its progress, and the same three actions — so the common case never needs the instance page at all.
A **paused** row reads `1d in, paused` rather than a countdown: nothing is counting down, and a
"23h 59m left" that still says the same tomorrow is a promise the page cannot keep.

### Blueprints with no phases

Not every blueprint is time-dependent, and some declare no phases at all. Import one with
`"phases": []` and derive it:

| Step                        | Expect                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Derive it                   | born **Running** — there is no lifecycle to start, and holding it inert would make it useless  |
| Its row in the setups list  | **no state chip, no phase line, no progress bar** — just `from <blueprint>`, exactly as before |
| Its row's actions           | **Pause** only; no Reset, because there is no banked time to discard                           |
| Instance page               | the lifecycle card is there ("its automations are simply live"), the phase track is not        |
| Pause it, then **Continue** | both work — the trap this closes: `stop` accepted it with no phase for `start` to enter        |

---

## 2b · Phase timers (F10.12)

Every phase change asks what to do with the clock, because before this a rollback silently
restarted the phase. Author a throwaway blueprint whose phases are measured in **seconds**
(`A` = 60s auto-advance → `B` = 120s auto-advance → `C` = no duration) — the whole lifecycle is
then observable in a couple of minutes instead of a fortnight.

| Step                                           | Expect                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Derive it                                      | phase **A** is current, its bar fills, `… left` counts down; the clock started on the wizard's last click |
| Wait for the cron                              | advances to **B** at 60s, with the usual `blueprint_phase_advanced` notification                          |
| ~30s into **B**, click **A** → **Start fresh** | A restarts from 0; **B** now reads `30s banked` and its bar is frozen there                               |
| Let A advance into **B** again                 | B starts at **0**, not 30s — auto-advance always resets; only a person spends a bank                      |
| Click **B** → **Resume**                       | dialog offers `30s in · 1m 30s left`; B continues from 30s and advances 90s later                         |
| Click **B** → **Start at** `5` `minutes`       | the ⚠ row appears ("will advance again straight away") and it does, on the next 10s tick                  |
| Sit in **C**                                   | no bar, a rising `in this phase 1m 20s`, and it never advances — a terminal phase is a resting state      |
| Click the **current** phase → **Start fresh**  | its running timer restarts; this is also how a mis-set clock is corrected                                 |
| Click the current phase → **Resume**           | not offered — there is no earlier visit to resume, only the run in flight                                 |

`api` logs carry `mode`, `banked` and `entering` on every change; `automation-worker` logs
`accrued` in `phase cron: evaluated`, which is the number that makes a resumed phase fire early.

---

## 2c · What ends a phase (F11.x — advance triggers)

A phase declares its own exit. In the builder, open a phase and use **Advances when**:

| Option                     | What ends the phase                                                    |
| -------------------------- | ---------------------------------------------------------------------- |
| **A person moves it on**   | nothing automatic — the user's Start / phase-change (the default)      |
| **The duration elapses**   | the schedule cron (this is the old "auto-advance"; §2b)                |
| **A rule fires**           | the derived rule you pick — when it fires, its owner advances          |
| **An AI pipeline decides** | the derived pipeline you pick — when its model returns `advance: true` |

**Advance to** is **Next phase** by default, or a specific phase of the same profile (a jump or a
rewind). The rule/pipeline picker only lists automations at the phase's **level**, and each offers
**Create** — an inline rule/pipeline pre-scoped to this phase, which you then finish in its own
section.

**The level rule (the load-bearing check).** Whether an advance moves the _setup_ or _one pot_ is
forced by the blueprint's shape, not chosen:

- **Plain setup** (no profiled slot): only `combined` automations are offered, and advancing steps
  the **whole setup**. _Test:_ author a rule (e.g. tank stable) as a `commissioning` phase's
  decider; start the setup; drive the rule's condition → the **setup** steps to the next phase and a
  second evaluation does **not** advance again (`automation-worker` logs `setup phase advanced`).
- **Garden with a profiled slot** (many pots): only `per_device` automations are offered, and
  advancing steps **just that pot**. _Test:_ give a profile's `seeding` phase a per-device pipeline
  decider; start the setup with several pots; feed **one** pot's telemetry so its model returns
  `advance: true` → **only that pot** moves (`pot phase advanced`, notification `Setup · Pot`),
  its siblings stay put.

**Lifecycle still gates it.** Pause the setup (or the pot) and repeat: **nothing advances** — the
rule/pipeline is held by `isAutomationLive` before it can decide. Automated advances always **reset**
the entered phase's clock (only a person resumes a bank).

**Validation.** Publishing a phase whose decider is the wrong level is refused, e.g. _"phase 'seeding'
is a per-device lifecycle, so the pipeline that advances it must be per-device"_ — try it once by
pointing a profiled-slot phase at a combined automation.

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

## 10a · One setup, devices on their own schedules (F11)

Until F11 a setup was in exactly ONE phase, so every device bound to a multi-device slot shared it.
A **profiled** slot changes that: each device bound there follows its own _profile_ (a named
lifecycle) and walks it on its own clock. The setup itself then has no phase — it only starts and
stops, and stopping it holds every device.

Author a blueprint with:

- a normal slot (the shared board) and a **profiled** multi-device slot;
- **two lifecycles** — in the builder's Phases section use the **Lifecycle** chips to add a second
  one, and give the two different phase durations (seconds, so you can watch one advance);
- a **question** in _Questions for the user_, asked **once per device** of the profiled slot, of
  type `select`, with each option naming a lifecycle;
- a rule whose _One per device?_ control is set to **One per device** over the profiled slot, with a
  `@phase.` threshold.

**Expected**

1. **Publish refuses** the rule if you set it back to _One for the setup_ while it reads `@phase.` —
   the message says each bound device is in its own phase. That combination genuinely cannot
   resolve, so it is rejected rather than silently resolving to one device's number.
2. **The wizard asks your question once per chosen device**, with the name box beside it, and does
   **not** also ask for the schedule — the answer picks it.
3. **The setups list** shows `N devices · M running` instead of a phase, because the setup has none.
4. **The setup page** splits into _Shared devices_ and _On their own schedule_, one card per device
   with its lifecycle, its phase, its timer and its own Start/Pause plus a menu holding its phases
   and _Reset / change schedule_.
5. **Start one device**: the other stays _Not started_. Move one to another phase: the other does
   not move. The short-duration one **auto-advances on its own** while the long one does not.
6. **Pause the setup**: every card dims and its buttons disable, while each card still reports what
   it individually is. Only the setup's own Continue brings them back.
7. **Reset a device** and pick the other lifecycle: it returns to _Not started_ and its phase track
   becomes the other lifecycle's. Its device and tuning are kept.
8. **Rules**: one derived rule per device, named `<rule> · <device>`, each with a single condition
   and a single action — not one condition per device. Check on the Rules page.

**What would be wrong**

- One rule with N conditions when the template says _One per device_ (that is the `combined` shape).
- A device showing a phase while its setup is paused, or a paused setup letting a device act.
- The wizard asking both the question and a separate "Schedule" for the same device.
- Both devices moving when you advance one.

## 10b · One automation for some of the devices (F11.9)

A template says how many automations it becomes (**One for the setup** / **One per device**) and,
separately, **which devices** they cover. The second control only appears once a multi-device slot
has per-device lifecycles to select by — there is otherwise no handle to select with.

Using the blueprint from 10a, add to it:

- a rule set to **One per device** over the profiled slot, with _Which devices_ narrowed to the
  **first** lifecycle only;
- a scene set to **One for the setup**, with _Which devices_ narrowed to the **second** lifecycle
  (leave `@phase.` out of it — see below).

**Expected**

1. Deriving with two devices on two different lifecycles produces **one** copy of the rule, named
   after the device on the selected lifecycle, and none for the other.
2. The scene is a **single** scene, keeping the name you gave it (nothing to tell apart), whose
   members cover only the device on the second lifecycle.
3. **Reset** the second device onto the first lifecycle, then publish a new version of the
   blueprint. Reconcile moves it: it gains the per-device rule and leaves the scene. The selection
   follows the device — this is why it is written as a lifecycle rather than a device list.
4. **Publish refuses** each selector that can never select anyone, with a message naming the cause:
   an undeclared lifecycle; a slot whose devices are shared rather than each on their own
   lifecycle; a slot the template never addresses.
5. Adding `@phase.` to the **combined** scene is still refused even though it is narrowed to one
   lifecycle — two devices on the same lifecycle still walk it on their own clocks.

**What would be wrong**

- Two copies of a rule restricted to one lifecycle, one of which can never fire.
- A narrowed combined scene acting on every device of the slot.
- The _Which devices_ control appearing for a setup whose devices are all shared.
- A device that changed lifecycle keeping its old automations after a reconcile.

## 10c · One lifecycle, devices whose phases run for different lengths (F11.13)

The case this exists for: two devices on the **same** lifecycle where one's first phase should be
shorter. Before, the duration lived on the phase and the phase belongs to the lifecycle, so the only
way to change one number was to duplicate the whole lifecycle.

In the builder, on a phase whose trigger is **schedule**, the _After_ box now takes a number **or**
a `@param.` chip. Author one that references a param, publish, derive with two devices on that same
lifecycle.

**Expected**

1. Each pot's card shows a **Just this one** section. Setting the referenced param there gives that
   pot a different phase length; the other pot keeps the blueprint's. The phase track on each card
   shows its **own** resolved duration, not the stored `@param.…` text.
2. **Applies to** on the same section writes a phase-scoped pin — "shorten this pot's seedling only"
   — and a phase belonging to a different lifecycle is refused by name.
3. The pinned pot advances first, on the same phase row, while its sibling is still in the phase.
4. **Publish refuses** a duration that is neither a positive number nor a declared param; a
   `@phase.` reference; and a param that this same phase's own targets set (the loop — the phase
   would change its own length the moment it began).
5. As an **admin**, a param the blueprint marks fixed is editable on a setup you own, tagged
   `admin`. As a plain user it stays read-only. Neither role can touch a setup belonging to someone
   else — that is still a 403.

**What would be wrong**

- Both pots advancing together despite one being pinned.
- A card showing `@param.seedling.days` where a duration should be.
- A user editing a fixed param, or an admin reaching another account's setup.
- A duration that fails to resolve advancing the phase anyway (it must hold instead).

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
