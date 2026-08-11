# blueprints/

Blueprint documents, in the shape `POST /api/admin/blueprints/import` accepts. These are **content**,
not code — the platform never reads this folder. They are kept here so a worked example survives a
database reset and can be diffed like anything else.

```bash
# import (creates or updates by `key`), then publish
curl -s -X POST localhost:3100/api/admin/blueprints/import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d @blueprints/garden.json
curl -s -X POST localhost:3100/api/admin/blueprints/<id>/publish \
  -H "Authorization: Bearer $TOKEN"
```

Or paste one into the builder's **Save or load** section.

| file          | what it exercises                                           |
| ------------- | ----------------------------------------------------------- |
| `garden.json` | the whole authoring surface — see the coverage table below. |

## What `garden.json` covers

Kept deliberately exhaustive: it is the document to import when you want to see every capability
rendered at once, and the first place a new option should be added.

| Area                 | Covered                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slots                | shared (unprofiled, 1..1) beside **profiled** multi-device (1..6), `required`, `sort_order`                                                                                                                                                                                                                                     |
| Fields               | all five `input_type`s (select/text/number/date/boolean), both scopes (`setup` + `binding`), `required`, `default_value`, `help_text`, options that **choose the lifecycle**                                                                                                                                                    |
| Params               | `user_tunable` both ways (`reservoir.critical` is admin-only), units (`%`, days, minutes), `sort_order`                                                                                                                                                                                                                         |
| Lifecycles           | four profiles; the same phase key in several of them                                                                                                                                                                                                                                                                            |
| Phase duration       | literal (`4 weeks`, `36 hours`, `60 seconds`), `@param.` reference, **`@field.` reference** — one pot's own answer sets its own phase length                                                                                                                                                                                    |
| Phase end            | all four `advance_mode`s: `schedule`, `manual`, `pipeline`, `rule` — plus `advance_to_key`, so `harvest → seedling` replants and the demo lifecycle loops forever                                                                                                                                                               |
| Fan-out              | `combined` and `per_device`, with `fan_out_profiles` selecting one or two lifecycles                                                                                                                                                                                                                                            |
| Gating               | `phase_scope` on a rule, a scene and a pipeline                                                                                                                                                                                                                                                                                 |
| Rule conditions      | `threshold` (`<`, `<=`, `>`, `>=`), `schedule` and `device_status`; `condition_operator` both `AND` and `OR`; specific `schedule_days` (weekday vs weekend) and a repeating `until` + `every_minutes` window                                                                                                                    |
| Rule actions         | `@phase.` / `@param.` references in `target_state`, **and in `delay_seconds` / `duration_seconds`** (F11.14)                                                                                                                                                                                                                    |
| Phase-owned schedule | the watering period, the watering hour and the lights-on/off hours are phase targets, not rule literals — so `daily_water`, `lights_on_*` and `lights_off` are **one rule each** across all four lifecycles                                                                                                                     |
| Scenes               | `combined` and `per_device`, member `sort_order`, `delay_seconds`, `duration_seconds`                                                                                                                                                                                                                                           |
| Pipelines            | both fan-outs, `enabled`, sensors with `inject_as_sensor` / `inject_as_action` / `min_value` / `max_value` and four `compression` modes (`average`, `last_n` + `n`, `min_max_avg`, `time_series`); two-stage `infer` → `command_exec` with `notify` + `execute_condition`; `sensor_threshold`, `schedule` and `manual` triggers |

The **Demo — fast cycle** lifecycle exists to be watched: its phases run 60s → `@param.demo.minutes`
→ 90s and then loop back, so a per-pot auto-advance can be seen happening rather than reasoned about.

> These documents carry the vocabulary of whatever they are for — `garden.json` names plants,
> because a lifecycle label and a phase name are content the engine never interprets. The
> generic-naming rule applies to platform code, seeds, docs and test data; it is exactly this
> separation that lets the same engine run a garden and a server room.
