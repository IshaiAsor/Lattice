# Blueprints

An admin authors a **blueprint** — a versioned template for a whole multi-device setup. A user
**derives** it into a live **setup**: their devices bound to its slots, in their own area, with real
scenes, rules and pipelines materialised from its templates.

Design history lives in [plans/blueprints-redesign.md](plans/blueprints-redesign.md); the tables are
in [../prisma/SCHEMA.md](../prisma/SCHEMA.md); the click-through script is
[MANUAL-TEST-F10-BLUEPRINTS.md](MANUAL-TEST-F10-BLUEPRINTS.md). **This file is what the feature
actually does**, for someone about to change it.

---

## 1. Vocabulary

| term                                 | what it is                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **blueprint**                        | the admin-authored, versioned definition. Owns slots, params, fields, lifecycles and templates.                                     |
| **slot**                             | a device requirement — "one tank board", "1–6 socket boards" — qualified by a released **sealed template**.                         |
| **sealed template**                  | the fixed action set of a factory-soldered device type. A slot's actions come from here, so addressing can be validated at publish. |
| **param**                            | a tunable number or string the blueprint declares. Referenced, never inlined.                                                       |
| **field**                            | a _question_ the blueprint asks the user at derive time. A stated fact, not a tunable value.                                        |
| **lifecycle** (`BlueprintProfile`)   | a named, ordered list of **phases** — a whole schedule, offered as one pickable thing.                                              |
| **phase**                            | one stage of a lifecycle: a name, an order, optionally a duration, plus per-param targets.                                          |
| **setup** (`BlueprintInstance`)      | one user's live derivation of a blueprint.                                                                                          |
| **binding** (`BlueprintSlotBinding`) | one device bound to one slot of one setup. On a _profiled_ slot it also carries its own lifecycle.                                  |
| **template**                         | a scene / rule / pipeline written against slots, materialised into real rows at derive.                                             |

The engine never interprets any of this content. A phase named "Flowering" and a lifecycle named
"Fruiting" are strings; nothing outside the blueprint knows what they mean.

---

## 2. Who owns the clock

This is the single most load-bearing distinction in the feature.

A slot may be marked **`profiled`**. That flag moves the schedule down a level:

```
unprofiled blueprint                    profiled blueprint
──────────────────────                  ──────────────────
setup  ── has current_phase             setup  ── no phase; start/pause only
  └ devices share it                      ├ device A ── own lifecycle, own phase, own clock
                                          ├ device B ── own lifecycle, own phase, own clock
                                          └ shared device (unprofiled slot) — no lifecycle
```

`setupHasOwnLifecycle(slots)` is literally `!slots.some(s => s.profiled)` — **the moment any slot is
profiled, the setup has no phase of its own.** The two shapes are mutually exclusive today; a setup
cannot have a phase track _and_ per-device ones.

A third shape exists: **static** (`blueprints.is_static`) — nothing in the setup is scheduled at all.
It still starts and pauses, because pausing means "hold this setup's automations", which is
meaningful with or without a schedule. `is_static` is _declared_, not inferred, and publish enforces
agreement both ways: a static blueprint may not declare lifecycles, and a non-static one must.
Without the flag, "I haven't written the phases yet" and "there is nothing to schedule" are
indistinguishable, and publishing the first silently ships an unfinished draft.

### Reading a lifecycle: tracks

`GET /api/blueprints/instances` carries the whole lifecycle, not just the phase it is in, because
the two questions a list has to answer are _where in the process is this_ and _how long until it
moves_. Each row has:

| Field           | Holds                                                                |
| --------------- | -------------------------------------------------------------------- |
| `phases`        | the **setup's** track — empty once any slot is profiled              |
| `device_tracks` | one track per profiled binding — empty when the setup owns the clock |

Exactly one of the two is populated, which follows from the shapes above: drawing both would show
the same time twice. A static setup has neither.

A _track_ is a lifecycle drawn rather than edited — per phase a `duration_seconds` to size it and an
`elapsed_seconds` to fill it, and nothing to act on. Only the current phase carries a live clock;
every other `elapsed_seconds` is that phase's bank. Moving a phase still needs the instance, so
starting from the list fetches it first: one read on a deliberate click, rather than the whole param
matrix on a page that mostly just gets looked at.

Consumed by the setups list (a row per track, with per-device pause) and the dashboard's setup tile
(a rail per track). Both size their segments with the same helpers in
`backoffice/src/app/utils/phase-track.util.ts` — including which device a card points at when
several disagree (`leadTrack`: running first, then soonest to change), so the same setup cannot be
summarised two different ways on two pages.

---

## 3. Addressing

A template names a device action as the pair **`(slot_key, mqtt_action_name)`**. Derive and
reconcile both turn that into concrete `user_device_action.id`s through one shared resolver
([blueprints.addressing.ts](../services/api/src/services/blueprints.addressing.ts)), keyed by
`${deviceId}:${actionName}`.

A reference to a multi-device slot fans out to **one id per bound device**. Narrowing a slot to a
subset is `scopedTo(slotKey, deviceIds)`, which re-keys the small slot→devices map and leaves every
_other_ slot resolving to all of its devices — which is what a per-device rule needs: its own
sensor, but the setup's shared actuator.

Publish rejects an `action_name` the slot's sealed template does not provide. That check is what
decides whether a derive can succeed at all, so it cannot be deferred to derive time.

---

## 4. Fan-out: how many automations, over which devices

Two independent questions, two columns on each `*_template` table.

**How many** (`fan_out`):

|                        |                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `combined` _(default)_ | one entity naming every bound device — "if **any** of them reports X". Every pre-F11 template.                                         |
| `per_device`           | one entity **per** bound device of `fan_out_slot_key`, each carrying `blueprint_binding_id` and resolving that slot to its own device. |

**Which devices** (`fan_out_profiles`) — a list of lifecycle keys, empty for all of them. Together:

| shape          | `fan_out`    | `fan_out_profiles` | reads as                               |
| -------------- | ------------ | ------------------ | -------------------------------------- |
| all, together  | `combined`   | `[]`               | "if any device reports X"              |
| all, one each  | `per_device` | `[]`               | "each device watches itself"           |
| some, together | `combined`   | `[a, b]`           | "if any device on a or b reports X"    |
| some, one each | `per_device` | `[a, b]`           | "each device on a or b watches itself" |

Selection is by **lifecycle, not device id**. An author writes a template long before the user owns
any device, so a device list is not something they could name — and a device moved onto another
lifecycle then joins and leaves the right automations by itself, where a stored list would go stale.

Both derive and reconcile compute their targets from the same function,
[`fanTargets`](../services/api/src/services/blueprints.fanout.ts), so they cannot disagree about how
many entities a template produces or which binding each belongs to. `FanTarget` carries two fields
on purpose: `deviceId` (the one binding it belongs to, or null) and `deviceIds` (what the fan-out
slot narrows to, or null for all) — a _combined_ entity over a subset covers several devices and
belongs to none, so it needs the narrowing without the identity.

**`per_device` is not a preference.** An automation over a profiled slot that holds a `@phase.`
reference _must_ be per-device: those devices are each in their own phase, one entity has one
resolution context, and a single reference cannot mean two numbers at once. Publish rejects the
combination — and narrowing to one lifecycle does **not** lift it, because two devices on the same
lifecycle still walk it on their own clocks.

---

## 5. References and precedence

Derived automations store **references**, not values. That is what lets the three actors who want to
change the same rule — reconcile, a phase advance, and the user — write to disjoint places without
clobbering each other.

Three kinds, one grammar ([packages/params/src/resolve.ts](../packages/params/src/resolve.ts)):

|            | resolves against                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@param.x` | the blueprint's own value for a setting **a phase may not retune** — phase-scoped layers are skipped.                                                        |
| `@phase.x` | the full precedence below. Also `@phase.key` / `@phase.name` / `@phase.context_notes` (reserved; a param may not use those keys).                            |
| `@field.x` | the answer: this binding's → the setup's → the field's default → null. **Does not walk the layers** — a field is a stated fact, and no phase retunes a fact. |

Six layers, most specific first, written once as data (`PARAM_LAYERS`) so resolution and the
instance page's "where did this come from" label cannot disagree:

```
binding_phase_override    this device, in this phase        ┐ phase-scoped
binding_override          this device, always               │
phase_override            this setup, in this phase         │ phase-scoped
override                  this setup, always                │
phase                     the phase's target                ┘ phase-scoped
default                   the blueprint's default
```

**Who may write which layer.** All four override layers are written through the API, never by
editing a derived row:

| layer                         | written by                                         | endpoint                                                    |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `binding_phase_override`      | the setup's owner, per device + phase              | `PUT /blueprints/bindings/:id/params/:key` with `phase_key` |
| `binding_override`            | the setup's owner, per device                      | the same, without `phase_key`                               |
| `phase_override` / `override` | the setup's owner                                  | `PUT /blueprints/instances/:id/params/:key`                 |
| `phase` / `default`           | the blueprint's author, then republish + reconcile | the admin builder                                           |

`user_tunable = false` means "the blueprint drives this through its phase targets" — the owner may
not pin it. **An admin may**, on a setup they own: the flag was never meant to lock the author out,
and without this the only way to correct one live setup's fixed value was to edit the blueprint and
republish it to every setup derived from it. Ownership is unchanged by that — an admin still gets a
403 on a setup belonging to someone else, so this widens _what_ an admin may edit, never _whose_.

An unresolvable reference returns **null**, never the raw text. Callers must treat that as
"condition false, log once" — failing closed, because comparing against `NaN` looks identical to a
threshold that was simply never crossed.

### Where a reference may be written

Not only in `target_state` and `threshold_value`. Since F11.14 the values _beside_ them take one
too, which is what stops a lifecycle-varying number forcing a duplicate template:

| position                                                              | kind    | resolved by            | when it cannot resolve            |
| --------------------------------------------------------------------- | ------- | ---------------------- | --------------------------------- |
| `target_state`, `threshold_value`, `min_value`/`max_value`            | any     | `resolveParam`         | condition false / not dispatched  |
| `duration_seconds` (rule action, scene member)                        | seconds | `resolveSeconds`       | hold indefinitely                 |
| `delay_seconds` (rule action, scene member)                           | seconds | `resolveSeconds`       | send now                          |
| `schedule_time` / `schedule_until` (rule condition, pipeline trigger) | `HH:MM` | `resolveClock`         | never fires                       |
| `duration_value` (a phase's own length, F11.13)                       | number  | `resolvePhaseDuration` | phase never advances on its clock |

The fallbacks differ on purpose: each is the behaviour that existed before the field did, so an
unresolvable reference degrades to the old default rather than inventing a number. Every one of them
is also a publish-time error, so the degradation should only ever be reachable through data that was
valid when written and later changed.

This is what collapses a garden's automations. "Water for 60s / 90s / 180s at 07:00 / 07:00 / 06:30"
was three rules differing by two numbers; with the numbers on the phase it is **one** rule reading
`@phase.water.time` and `@phase.water.seconds`, and adding a fourth lifecycle adds no rules at all.

A literal is still a literal — `duration_seconds: 90` means ninety seconds exactly as it did — so
nothing already authored changes meaning.

The two binding layers are absent on a context that describes no binding, so an unprofiled setup
resolves through exactly the four layers it always did.

> **Note.** On a profiled setup, a _setup-level_ phase-scoped override is split against the
> **binding's** phase key, because that is the only phase in play. So an override scoped to
> `seedling` applies to every device currently in a phase keyed `seedling` — **including devices on
> a different lifecycle that happens to declare the same key.** Phase keys are unique per lifecycle,
> not per blueprint.

---

## 6. Gating: may this automation act right now?

One function, three call sites (rule engine, pipeline triggers, scene execution) so they cannot
disagree — an automation that fires in one path and is held in another is a bug no single service's
tests would catch.

```ts
isAutomationLive(scope, currentPhaseKey, lifecycleState, bindingLifecycleState?)
  = isInstanceRunning(lifecycleState)          // the setup is running
  && isInstanceRunning(bindingLifecycleState)  // …and its device, for a per-device automation
  && isPhaseInScope(scope, currentPhaseKey)    // …and the automation is in scope for that phase
```

- A null/absent lifecycle means "not from a blueprint" — hand-written rules are always live, which
  is what keeps this gate invisible to the rest of the platform.
- A **stopped setup holds everything, emergency rules included.** Stopping means "this setup is
  off", not "off except the parts that matter".
- An empty `phase_scope` means every phase. A non-empty scope against a _null_ current phase is
  never in scope — you cannot be "in" a phase that is not set.
- `effectiveLifecycle(binding, instance)` collapses the two into the one value the UI shows, so no
  caller can check the binding and forget the setup.

---

## 7. Phase advance

Each phase declares **what ends it** (`advance_mode`), and owns **where that goes**
(`advance_to_key`, null ⇒ next by ordinal). The referenced automation supplies only the _decision_.

| `advance_mode`       | ended by                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| `manual` _(default)_ | a person — start / set-phase                                                            |
| `schedule`           | the elapsed-duration cron. Requires a duration.                                         |
| `rule`               | the derived `UserRule` of `advance_ref_key` firing                                      |
| `pipeline`           | the derived `Pipeline` of `advance_ref_key` returning `phase_transition.advance = true` |

**A duration may be a reference** (F11.13). `duration_value` holds a literal (`"7"`) or an
`@param.` reference, resolved against the _owner's_ context at the moment the cron checks it — the
binding's for a per-device lifecycle, the setup's otherwise. That is what lets one lifecycle hold
devices whose phases run for different lengths: the phase says "as long as `seedling.days` says",
and the device that needs a shorter one pins that param for itself. Without it, changing one number
meant duplicating a whole lifecycle, and that duplicate then had to be listed in every
`fan_out_profiles` that named the original.

Three refusals at publish, because all three fail the same silent way — `phaseDurationSeconds`
reads anything it cannot parse as "no duration", so a bad one does not error, the phase just never
advances:

- a literal that is not a positive number;
- a reference to an undeclared param/field;
- **`@phase.`**, and a `@param.` the same phase's own targets set — "this phase lasts as long as `x`
  says, and entering it sets `x`" is a loop, and a duration is read before the phase is entered.

An unresolvable reference at evaluation time fails **closed**: no duration, so the phase holds. A
phase that overstays is visible; one that ends early on a number nobody wrote is not.

All four converge on **one** banking advance (`advanceSetupPhase` / `advanceBindingPhase`), so no
trigger can bank time differently from another. The advance writes two phase columns and two time
banks — **no automation row is rewritten**, so every `@phase.x` reference simply retunes at the next
evaluation, and a user's edits and a pending reconcile cannot be clobbered by a phase change.

On the banks, an automated advance takes a deliberately narrow line: it **credits** the phase it
leaves so a rollback has something to resume, and always **resets** the phase it enters. Spending a
bank stays an explicit human act — an automated advance must never resurrect time from an earlier
visit and silently shorten a phase.

Two safety properties worth not breaking:

- **Idempotent.** `resolveAdvanceTarget` returns null when the target _is_ the current phase, so a
  repeat trigger cannot double-bank.
- **Guarded.** A rule-triggered advance re-reads the owner's current phase and confirms it still
  names _that exact rule_ as its decider, on the same read that performs the move. A rule that fired
  for any other reason, or after the phase already moved, is a no-op.

`nextPhase` uses the next-highest ordinal, not `ordinal + 1`, so a v2 that removes a middle phase
still advances.

Validation ties the decider to the right level: a per-device phase needs a `per_device` decider that
covers its profile; a setup phase needs a combined one.

---

## 8. Derive

1. Match each slot to candidate devices (right sealed type, not already held by another setup — a
   device belongs to at most one setup).
2. Read the **field** answers. A required field with neither an answer nor a default is a 400. An
   answered `select` option carrying `profile_key` **sets the binding's lifecycle** — one question,
   both facts: "what is this handling?" records the answer _and_ picks the schedule.
3. Resolve every template to concrete action ids and fan it out — all of it **before** any write, so
   a device missing its config reports every gap at once rather than one per retry.
4. In one transaction: create the area, the instance, each binding (one at a time, because a
   per-device entity needs the binding's id), then the scenes / rules / pipelines.

A derived setup is **not started**. Binding a board says nothing about when the process it watches
began, so no phase is entered and no clock runs until the user starts it and says where they are.
The exceptions are a setup with no phases (born running — it would otherwise be permanently inert
under the gate) and a profiled setup (born running; its _devices_ are each started separately).

---

## 9. Reconcile and drift

Publishing a new blueprint version flows into every live setup. Reconcile is **idempotent** —
every decision is a comparison against the template, not a replay of a delta.

Identity is the pair **`(blueprint_key, blueprint_binding_id)`**. That one key covers two cases:
a template dropped from the blueprint, and a device removed from (or moved out of) a multi-device
slot — the automations belonging to that device stop, the others carry on untouched.

Outcomes: `created`, `updated`, `skipped_user_modified`, `unresolvable`, `disabled`.

**Drift.** Editing a derived rule's _content_ marks it `user_modified`, and reconcile leaves it alone
from then on; the instance page offers a reset that restores it from the blueprint. Enabling or
disabling a rule is deliberately **not** drift — it is not an opinion about the rule's content.

An entity whose references cannot all be resolved is reported `unresolvable` and left **as-is**,
never written half-wired.

---

## 10. The publish gate

A draft may be incomplete; publish refuses anything a derive could not satisfy. Catching a bad
reference here is the whole point — at evaluation time an undeclared `@param.x` is indistinguishable
from a deleted one, and both just silently stop the rule from firing.

Two callers run the _same_ checks: the stored blueprint, and an unsaved document straight from the
builder. A builder that validates something other than what you are looking at is worse than no
validate button, so both normalise to one shape and run one function.

What it rejects, and why each one is invisible at runtime:

- a slot targeting a non-`released` sealed template — a derive would produce a device with no actions
- an `action_name` the slot's sealed template does not provide
- an undeclared `@param.` / `@field.` reference, or a param with no default that no phase sets
- a param key colliding with reserved phase metadata (`key`, `name`, `context_notes`)
- a `phase_scope` naming a phase no lifecycle declares — the automation would be permanently inert
- `is_static` disagreeing with the lifecycles present, **in both directions**
- `per_device` over a single-device slot, or over a slot the template never addresses (every copy
  would be identical)
- `combined` + `@phase.` (or a `phase_scope`) over a profiled slot — genuinely unresolvable
- a `fan_out_profiles` selector that can never select anybody: no slot, an unprofiled slot, an
  undeclared lifecycle, or a slot the template never addresses
- a phase whose decider does not exist, or sits at the wrong lifecycle level
- `advance_to_key` naming a phase outside the phase's own profile, or itself

---

## 11. The LLM context block

For a single-device sensor group nothing changed — existing prompts keep working. For a
**multi-device** group the flat `sensors[group][action]` map is lossy (several devices in one group
overwrite each other), so enrich emits a structured per-device block instead: each device's label,
lifecycle, phase, field answers, readings, **its own** expected ranges, and its own actions.

`expected_ranges` is the piece that makes this work: it is resolved per run from each binding's own
`ParamContext`, so each device's band comes from its own lifecycle's phase with no new machinery.

Fan-out follows: the LLM pipeline is `combined` (it must see everything); deterministic rules are
`per_device`. This is also why `combined` + `@phase.` is rejected — the per-device block is what a
setup-wide automation reads instead.

---

## 11a. Schedules

A schedule — a rule condition or a pipeline trigger, the same shape for both — is either a single
time or a repeating window:

|                                               |                                                    |
| --------------------------------------------- | -------------------------------------------------- |
| `schedule_time` alone                         | fires at that minute, once a day                   |
| `+ schedule_until` `+ schedule_every_minutes` | fires at `time`, `time + every`, … through `until` |

plus `schedule_days` (empty = every day). Half a window is rejected at publish: an end with no step
never repeats, a step with no end has nothing to repeat within. A window that ends before it starts
(a midnight crossing) is rejected too rather than guessed at.

`schedule_cron` used to sit on pipeline triggers. It was accepted at publish, persisted, derived and
reconciled — and **never evaluated**, so a pipeline whose only trigger was a schedule never ran at
all. It is gone; both surfaces share `matchesSchedule` and one 10s scan.

One definition, in `@lattice/params/schedule` — `ScheduleSpec`, `matchesSchedule`,
`validateSchedule`, `describeSchedule`. Every writer of a schedule runs the same validator (the user
rules API, the pipelines API, blueprint publish) and both evaluators run the same matcher, so a
schedule that saves on one surface cannot be rejected or read differently on another. The backoffice
keeps a cosmetic copy of the describer only — it is a separate npm project and cannot import from
`packages/`.

**Fired once per minute, by the minute.** A schedule matches a _minute_ while the scans tick every
ten seconds, so `firedThisMinute` — not the user's cooldown — is what makes "at 06:00" mean once.
The per-automation rate limits (`cooldown_seconds`, `min_interval_sec`) are a further limit on top,
and may be short or unset. The guard compares clock minutes rather than elapsed seconds, because a
one-minute interval puts consecutive firings 55–65 seconds apart depending on where in the minute
the tick lands, and a 60-second floor would drop every other one.

The in-memory check is not enough on its own: two evaluators run concurrently — the 10s schedule
scan and the telemetry-driven pass — and both read `last_triggered` before either writes it, so one
firing dispatched twice (observed live, two identical commands one second apart). Firing a schedule
therefore **claims the minute first**, with a conditional update that matches only while the stamp
is still older than the current minute, and acts only if it won. The same claim guards pipeline
schedule triggers, where a second worker replica is the racing party.

**How long the device then holds the state is not part of this** — that is the action's
`duration_seconds`, armed by the firmware itself. "On for 30 seconds every 10 minutes from 06:00 to
17:30" is a window plus a hold, and neither half is a timer this platform has to keep alive.

**Timezone.** A schedule is read against `users.timezone` — the owner's IANA zone, not the
evaluating process's. Without that it used the container's zone, which is UTC: a user in Israel who
wrote 06:00 got a rule that fired at 09:00 their time. The single-time shape hid it; a window does
not, because "from 06:00 to 17:30" is a sentence about daylight.

The client sets the column from the browser on the first authenticated load when nothing is stored,
so **local is the default without anyone choosing it**, and the profile menu's _Timezone_ picker is
for the case where the devices are somewhere the browser is not. NULL keeps the old behaviour (the
server's zone), and a stored zone this runtime does not recognise falls back to it rather than
never firing — an ICU update retiring a name must not silently stop a schedule.

## 12. Known limits

- A setup cannot have a lifecycle of its own **and** per-device lifecycles at the same time.
  `setupHasOwnLifecycle` is either/or.
- Phase keys are unique **per lifecycle**, not per blueprint. `phase_scope` and setup-level
  phase-scoped overrides match by key, so the same key in two lifecycles is the same target.
- A `per_device` automation over a slot whose devices are on several lifecycles materialises on all
  of them unless `fan_out_profiles` narrows it; gating it by `phase_scope` alone leaves a live row
  on devices that can never enter that phase.
- A pulsed actuator should use `duration_seconds` on the action, not a second delayed OFF: the
  device arms its own timer, so nothing on the platform side can lose it. A delayed action's timer
  _is_ still an in-process `setTimeout`, so use `delay_seconds` for staggering, not for closing.
  A device that reboots mid-pulse restores its saved ON state with no timer armed, so a blueprint
  that drives something consequential still wants an independent "close everything" rule.
- `disabled_by_reconcile` records the author of a disable, so reconcile restores what it switched
  off and leaves a user's own toggle alone. Any manual toggle takes ownership of the flag.
