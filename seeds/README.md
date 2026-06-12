# Lattice Platform — Reference Seeds

Import these files via the Admin UI to bootstrap a fresh instance with a working reference configuration.

## Import order (matters — blueprints reference catalog IDs)

### 1. Catalog  (`reference-catalog.json`)
**Who:** Admin  
**Where:** `/admin/catalog` → **Import Catalog**  
**What:** Two device models (`esp32s3_mini`, `esp32s3_cam`) with full action sets, and three ML models (`rule_generator`, `qwen2.5vl`, `visual-inspector`).

### 2. Blueprints  (`reference-blueprints.json`)
**Who:** Admin  
**Where:** `/admin/blueprints` → **Import**  
**What:** A draft blueprint with two device slots, two ML pipelines, three automation rules, and two emergency safeguards. After importing, publish it from the Builder if you want users to be able to derive it.

### 3. User config  (`reference-user-config.json`)
**Who:** Any user  
**Where:**
- `/rules` → **Import** (loads 4 automation rules)
- `/emergency` → **Import** (loads 2 emergency rules)
- `/pipelines` → **Import** (loads 2 pipelines)

The user config is capability-scoped (no device-instance IDs) so it works on any account regardless of which devices are provisioned.

## File formats

All files use the same JSON envelope format produced by the Export buttons in the UI:

| File | Envelope key | Import endpoint |
|---|---|---|
| `reference-catalog.json` | `models`, `ml_models` | `POST /api/admin/catalog/import` |
| `reference-blueprints.json` | `blueprints` | `POST /api/admin/blueprints/import` |
| `reference-user-config.json` | `rules`, `emergency_rules`, `pipelines` | Multiple endpoints |

## Notes

- Catalog import is **upsert** by `(model_key, version)` — safe to re-run.
- Blueprint import always **creates new drafts** — duplicate imports create new blueprints with the same name.
- User config import is **additive** — duplicate imports create duplicate rules/pipelines.
