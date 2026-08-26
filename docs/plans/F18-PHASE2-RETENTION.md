# F18 Phase 2 — Elastic, Scoped Retention Tiers

**Status:** approved, Step 1 built · **Covers:** F18.9 – F18.16 · **Builds on:** F18.1–F18.7 (Phase 1, on `master` as `a8315f9`)

---

## Decisions taken with the user (2026-08-24)

§10 below asked seven questions. All are now answered, and three of the answers went **against**
what the rest of this document originally proposed. Those sections have been rewritten; this list is
the record of why they changed.

1. **`raw` is a tier**, at position 0 — not a kind-level window beside the tier list. Per-action raw
   windows come free; the cost is that Phase 1's raw path, its columns and its tests are rewritten.
   §1.1, §1.2 and §1.4 were rewritten for this.
2. **The whole list wins, not tier by tier** — the most specific scope with any rows supplies every
   tier. (Confirmed as proposed.)
3. **"No rollups for this sensor" is a tier list of raw alone.** With raw in the list, an empty
   rollup set has a natural spelling and the `bucket = 'none'` sentinel §10.3 proposed is dropped.
4. **Per-user sweep locks plus a global gate**, not one global key — one user's Apply is not blocked
   by another's, but a platform sweep and any user sweep are mutually exclusive. §3.4 and §4.4 were
   rewritten for this.
5. **A lowered ceiling trims at once and notifies.** No grace period: it would mean knowingly
   storing data above the platform's own stated ceiling.
6. **Blueprint tiers address `(blueprint_id, slot_key, action_name)`.** (Confirmed as proposed.)
7. **The bucket vocabulary is a table, and any user may add to it** — not a fixed list in code.
   §1.1 was rewritten for this; the FK it creates is also what makes the `sensor_rollup` vocabulary
   rewrite in §1.5 a checked migration rather than a silent one.

---

## Superseded after build (2026-08-26)

**`max_tiers` is gone.** This document specifies a per-kind cap on tier-list length (`scalar` 5,
`command`/`device_event` 2, `frame` 1) in §1.4, §1.5 step 8, §2.2, §7 and §9. It was built, shipped,
and then removed on the user's instruction — _"do not limit any buckets for any data kind"_ — with
migration `20260826140000_drop_max_tiers`. Every `max_tiers` reference below is therefore historical.

The cap limited the wrong axis. A tier list costs what its **finest** bucket costs: a `30m` tier
writes 48 rollup rows per sensor per day, while every coarser tier stacked above it together writes
about one. A count cap blocks the nearly-free additions and permits the expensive one, and it let a
list sit at the limit while costing far more than a longer, coarser list. It also produced a real
dead end in the UI — at the limit the whole add row was replaced by the limit message, taking the
"＋ Custom size…" entry with it, so the custom-bucket feature became unreachable.

What still bounds a list, and did all along:

- **`min_bucket`** — the axis that actually costs.
- **The chain rule** — each tier a whole multiple of the one below, so between the 60-second floor
  and the 3650-day ceiling a strictly-multiplying chain cannot hold much beyond twenty entries.
- **Per-kind bucket eligibility**, which is NOT a policy limit and stays in code: `command` and
  `device_event` roll up into `DATE`-keyed tables and so take whole-day buckets only, and `frame`
  takes none, because an image has no average. These are properties of where the rows live, and no
  admin can raise them.

## 0. What is already true (Phase 1)

Read before starting: `prisma/migrations/20260821120000_history_rollups/migration.sql`,
`services/automation-worker/src/services/retention-logic.ts`,
`services/automation-worker/src/services/retention.service.ts`,
`services/api/src/services/{retention.service.ts,retention-rules.ts,history.service.ts,history-bucket.ts}`.

Two encodings meet everywhere in this feature and are deliberately different — they carry into
Phase 2 unchanged:

- on a `*_days` column, `0` means **KEEP FOREVER** (the safe reading for a number driving DELETEs);
- on a `max_*` ceiling, `NULL` means **UNCAPPED** (a ceiling of `0` would read as "cap everyone at
  forever").

So forever is the _largest_ value despite being numerically the smallest, and clamping treats it as
infinity rather than reaching for `Math.min`.

---

## 1. Schema

### 1.1 Bucket vocabulary — a table, not a constant

`retention_buckets` is a real, editable catalog. Seeded with `raw` · `5m` · `15m` · `30m` · `1h` ·
`6h` · `12h` · `1d` · `1w`, and **any user — not only an admin — may add their own**: `90m`,
`45m`, `4h`, whatever their sensors deserve, with no release.

| column                  | notes                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `code`                  | PK, `VarChar(12)` — the value stored in every `bucket` column |
| `seconds`               | the bucket's fixed duration; `0` for the `raw` sentinel       |
| `label`                 | what the UI shows ("90 minutes")                              |
| `anchor_offset_seconds` | shifts the boundary grid; `0` for almost everything           |
| `is_builtin`            | seeded rows, which nobody may delete                          |
| `created_by_user_id`    | audit, and who may delete it later                            |

Every `bucket` column in the five tier tables, plus `sensor_rollup.bucket` and
`retention_policy.min_bucket`, FKs to `retention_buckets(code)`.

**One shared catalog, not one per user.** A bucket size is a unit, not personal data: two users who
both want 90 minutes want the same 5400 seconds, so they share one row, and adding a code that
already exists reuses it. That keeps a single FK target, which is the whole reason the table exists
— a per-user catalog would mean either a second table (and then `sensor_rollup.bucket` cannot FK to
both) or a nullable owner in the unique key, which Postgres's NULL-distinct rule makes unsafe, as
this schema records in three other places. The honest trade: a size one user adds is visible to
everyone, because it is arithmetic rather than information. What stays private is the part that
actually is private — **which** buckets you keep and for how long, in your own tier list.

Guard rails, all enforced in the service:

- The admission rules below reject most junk outright.
- Creation is refused below the strictest `retention_policy.min_bucket`, so the catalog cannot fill
  with rows nobody may use.
- A global cap on non-builtin rows (`RETENTION_MAX_CUSTOM_BUCKETS`, default 32) — the catalog is a
  vocabulary, not a scratch pad.
- Delete only for a **non-builtin, entirely unused** bucket, by its creator or an admin. "Unused"
  means no tier row (the FK proves it) _and_ no `sensor_rollup` row, which the FK cannot see.

#### What stays in code, and why it is a short list

Flooring is generic: `bucketStart(d, seconds, anchorOffset)` = `floor((epoch − a) / s) * s + a`,
correct for **any** fixed duration, so 90 minutes needs no special case. `anchor_offset_seconds`
exists for the one seeded row where the epoch grid is wrong: `1w` floored on epoch multiples lands
on a **Thursday** (1 Jan 1970 was one), so its row carries `345600` to move the grid to Monday.

- **Chain divisibility** (`assertTierList`). A coarse bucket is folded from the next finer one, so
  each tier's `seconds` must be a whole multiple of its predecessor's. This constrains the **list**,
  not the size — `90m` is legal, it just cannot sit directly above `1h` (5400 / 3600 = 1.5). The
  refusal names both numbers and suggests the nearest workable predecessor.

  ```
  raw → 15m → 90m → 1d     ✓   6× then 16×
  raw → 90m → 1d           ✓   16×
  raw → 1h  → 90m          ✗   1.5× — "90m cannot fold from 1h; use 30m or 45m below it"
  ```

- **Admission rules**: `seconds >= 60`, and it must either divide 86 400 evenly or be a whole number
  of days, so every boundary falls at the same clock time every day. (`90m` → 16 per day ✓; `7h`
  → 3.43 ✗, answered with "try 6h or 8h".)
- **Per-kind limits**: `scalar` → any bucket; `command` and `device_event` → `raw` plus whole-day
  buckets only, because `command_rollup_daily` and `device_availability_daily` are `DATE`-keyed;
  `frame` → `raw` only.

#### Two immutability rules

- **`seconds` is frozen once any `sensor_rollup` row uses the code.** Existing rows were aggregated
  at the old width; changing it would silently reinterpret them. The API offers no `PATCH` of
  `seconds` at all — the route does not exist, rather than existing and refusing.
- **A bucket in use cannot be deleted.** The FK covers tier rows; a pre-delete check covers
  `sensor_rollup` rows, which have no FK-visible dependency on being _configured_.

#### The one thing this still cannot do

**Calendar buckets** — `1mo`, `1q` — are not a fixed number of seconds, so they cannot be a row
here. They would need a `kind: 'calendar'` discriminator and real calendar arithmetic in
`bucketStart`. Out of scope, and worth knowing before someone adds `30d` and calls it a month.

#### `raw` is special in exactly two ways

1. **It is never built** — `sensor_history` is written by digest-service on every reading,
   unconditionally. A raw tier sets how long rows are _kept_, never whether they are written.
2. **It is mandatory and floored.** The finest rollup tier reads raw to build itself, so a raw
   window shorter than the rollup lookback deletes rows before they were ever aggregated.
   `assertTierList` rejects a list with no `raw` row, and rejects
   `raw.keep_days < max(RETENTION_LOOKBACK_DAYS, 2)` unless it is `0` (forever). **This floor is the
   single most important new invariant in Phase 2** — without it a user shortening raw silently
   destroys their own long-range history.

### 1.2 New models

Five tier tables, one per scope. **One table per scope, not one table with a nullable owner** — the
same reason `user_retention_preferences` is separate from `retention_policy`: Postgres treats NULLs
as _distinct_ in a unique index, so a nullable-owner unique key would happily allow two platform
rows for the same `(data_kind, bucket)`. A partial unique index would work but cannot be expressed
in `schema.prisma`, so the schema would stop describing the database. One table per scope also buys
real FKs and real cascades: deleting an action takes its tiers with it.

Every `bucket` column below is `VarChar(12)` and **FKs to `retention_buckets(code)`** (§1.1), so a
tier can only ever name a size the catalog holds — including `raw`, which is a row like any other.

```prisma
model RetentionPolicyTier {          // @@map("retention_policy_tiers")
  id                 Int      @id @default(autoincrement())
  data_kind          String   @db.VarChar(20)   // FK → retention_policy.data_kind (it is @unique)
  bucket             String   @db.VarChar(12)  // FK -> retention_buckets.code
  keep_days          Int      @default(0)       // 0 = forever
  max_keep_days      Int?                       // NULL = uncapped — the ceiling for THIS bucket
  position           Int      @default(0)
  updated_by_user_id Int?
  updated_at         DateTime @default(now()) @updatedAt @db.Timestamptz(6)

  policy     RetentionPolicy @relation(fields: [data_kind], references: [data_kind], onDelete: Cascade)
  updated_by User?           @relation(fields: [updated_by_user_id], references: [id], onDelete: SetNull)

  @@unique([data_kind, bucket])
  @@index([data_kind, position])
}

model UserRetentionTier {            // @@map("user_retention_tiers")
  id Int @id @default(autoincrement())
  user_id Int; data_kind String @db.VarChar(20); bucket String @db.VarChar(12)
  keep_days Int @default(0); position Int @default(0); updated_at DateTime @default(now()) @updatedAt @db.Timestamptz(6)
  user User @relation(fields: [user_id], references: [id], onDelete: Cascade)
  @@unique([user_id, data_kind, bucket])
  @@index([user_id, data_kind, position])
}

model DeviceRetentionTier   // @@map("device_retention_tiers")   — same shape, user_device_id
model ActionRetentionTier   // @@map("action_retention_tiers")   — same shape, user_device_action_id

model BlueprintRetentionTier {       // @@map("blueprint_retention_tiers")
  id Int @id @default(autoincrement())
  blueprint_id Int
  slot_key    String @db.VarChar(64)   // plain strings, like BlueprintSlotBinding.slot_key —
  action_name String @db.VarChar(64)   // they survive a v2 publish recreating the slot rows
  data_kind String @db.VarChar(20); bucket String @db.VarChar(12)
  keep_days Int @default(0); position Int @default(0)
  blueprint Blueprint @relation(fields: [blueprint_id], references: [id], onDelete: Cascade)
  @@unique([blueprint_id, slot_key, action_name, data_kind, bucket])
}
```

`action_name` is `user_device_actions.mqtt_action_name` — the same stable identity
`BlueprintRuleTemplate` uses to address a device's action by `(slot_key, action_name)`.

The **platform row carries both the default and the ceiling** (`keep_days` + `max_keep_days`),
exactly mirroring the `default_* / max_*` pairing Phase 1 used. Every other scope carries
`keep_days` only. That is what F18.11 needs to reject an over-ceiling write per tier.

Because **raw is a tier** (decision 1), a `raw` row in any of these tables is a per-scope raw
window — which is where per-action and per-device raw retention comes from without a single extra
column. It also means a tier list is the _complete_ retention configuration for a
`(scope, data_kind)`: there is no second window living somewhere else.

### 1.3 Job-history models (F18.14)

```prisma
model RetentionRun {                 // @@map("retention_runs")
  id                  Int      @id @default(autoincrement())
  trigger             String   @db.VarChar(8)    // cron | admin | user
  status              String   @db.VarChar(10)   // queued | running | ok | failed
  phase               String?  @db.VarChar(32)   // rollup:scalar | prune:frame | … live progress
  requested_by_user_id Int?
  scope_user_id       Int?                       // non-null = a user-scoped sweep (F18.15)
  // 'global' for a platform sweep, 'user:<id>' for a user sweep. Held from queued until terminal,
  // then set NULL. Postgres's NULL-distinct rule is documented as a trap everywhere else in this
  // schema; here it is the feature — any number of finished rows carry NULL, and exactly one live
  // run can hold each key. The key alone does not stop a user sweep overlapping a global one; the
  // advisory-lock gate in §3.4 does.
  lock_key            String?  @unique @db.VarChar(32)
  queued_at   DateTime  @default(now()) @db.Timestamptz(6)
  started_at  DateTime? @db.Timestamptz(6)
  finished_at DateTime? @db.Timestamptz(6)
  duration_ms Int?
  error       String?
  kinds RetentionRunKind[]
  @@index([queued_at])
}

model RetentionRunKind {             // @@map("retention_run_kinds")
  id Int @id @default(autoincrement())
  run_id Int; data_kind String @db.VarChar(20)
  buckets_written Int @default(0); rows_deleted Int @default(0)
  bytes_reclaimed BigInt @default(0)
  bytes_estimated Boolean @default(true)   // false only for frames (summed byte_size)
  run RetentionRun @relation(fields: [run_id], references: [id], onDelete: Cascade)
  @@unique([run_id, data_kind])
}
```

Relational child rows rather than a JSON counters blob — the same call the user made for tiers on
2026-08-23, and it lets the page sort and total by kind.

### 1.4 Columns added / dropped on existing tables

Added to `retention_policy`:

- `min_bucket VARCHAR(12) NOT NULL DEFAULT 'raw'` — the finest _summary_ granularity anyone may
  choose. It never binds `raw`: the floor is about how fine a summary may be, and raw is not a
  summary.
- `max_tiers INT NOT NULL` — seeded per kind: `scalar` 5, `command`/`device_event` 2, `frame` 1.

Dropped from `retention_policy` (**after folding**): **all six** day columns —
`default_raw_days`, `default_hourly_days`, `default_daily_days`, `max_raw_days`,
`max_hourly_days`, `max_daily_days`. What remains is `data_kind`, `enabled`, `updated_at`,
`updated_by_user_id` plus the two knobs above.

`user_retention_preferences` is **dropped entirely**. With `raw_days`, `hourly_days` and
`daily_days` all folded into `user_retention_tiers`, nothing is left. Its one job that is not a
window — "has this user overridden anything", which `mine()` answers from row _presence_ rather than
a value comparison — transfers cleanly to "has any `user_retention_tiers` row for this kind", and
keeps the property that makes defaults worth having: changing one moves everyone who never
customised.

This is the blast radius of decision 1, and it is the reason Step 2 stops for review on its own.

### 1.5 Migration `prisma/migrations/<ts>_retention_tiers/migration.sql`

Order is load-bearing. Steps 2–4 must all run before step 6.

Order is load-bearing; steps 2-4 must all run before step 5.

1. **`CREATE TABLE retention_buckets` and seed the nine codes.** First, because everything below
   references it.
2. `CREATE TABLE` the five tier tables and the two job tables, each `bucket` column FK'd to
   `retention_buckets(code)`.
3. **Fold the platform columns into `retention_policy_tiers`** — `raw` at position 0 from
   `default_raw_days`/`max_raw_days`, then `1h` and `1d` from the hourly/daily pairs.

   ```sql
   INSERT INTO retention_policy_tiers (data_kind, bucket, keep_days, max_keep_days, position)
   SELECT data_kind, 'raw', default_raw_days, max_raw_days, 0 FROM retention_policy;

   INSERT INTO retention_policy_tiers (data_kind, bucket, keep_days, max_keep_days, position)
   SELECT data_kind, '1h', COALESCE(default_hourly_days, 0), max_hourly_days, 1
   FROM retention_policy
   WHERE default_hourly_days IS NOT NULL OR max_hourly_days IS NOT NULL;
   -- and the same for '1d' from default_daily_days / max_daily_days at position 2
   ```

   A NULL default with a non-NULL ceiling **still becomes a row**, or the ceiling is silently lost.

4. **Fold `user_retention_preferences` into `user_retention_tiers`** the same way — one row per
   non-NULL column, and `raw` always.
5. **Rewrite the existing rollup rows to the new vocabulary.**

   ```sql
   UPDATE sensor_rollup SET bucket = '1h' WHERE bucket = 'hour';
   UPDATE sensor_rollup SET bucket = '1d' WHERE bucket = 'day';
   ```

   Without it every bucket ever written becomes invisible to the new reader and is immediately
   deleted by the orphan sweep in §3.3. No unique-key collision is possible: nothing has ever
   written `'1h'`/`'1d'`.

6. **`ALTER TABLE sensor_rollup ADD CONSTRAINT … FOREIGN KEY (bucket) REFERENCES retention_buckets(code)`.**
   This is where the catalog earns its place. Postgres validates every existing row as it adds the
   constraint, so a missed or partial step 5 **fails the migration loudly** instead of silently
   orphaning every rollup ever written — what was the most dangerous line in this migration becomes
   a checked one. (Costs one full scan of `sensor_rollup`: tens of thousands of rows today,
   seconds.)
7. `ALTER TABLE retention_policy` add `min_bucket` (FK to `retention_buckets`) and `max_tiers`, then
   **drop all six day columns**; `DROP TABLE user_retention_preferences`.
8. Seed the knobs: `scalar` → `min_bucket='raw'`, `max_tiers=5`; `command`/`device_event` →
   `min_bucket='raw'`, `max_tiers=2`; `frame` → `min_bucket='raw'`, `max_tiers=1`.
   `ON CONFLICT DO NOTHING` throughout so a re-run is harmless, matching the Phase 1 migration's
   style.

### 1.6 `prisma/SCHEMA.md` (hard repo rule — same change)

- **Mermaid ERD**: `RetentionBucket` belongs in the **Tier 0** catalog block beside
  `google_action_types` — it is the same kind of thing, a small reference table other tables FK
  into. The rest go in Tier 6: add `RetentionPolicyTier`, `UserRetentionTier`, `DeviceRetentionTier`,
  `ActionRetentionTier`, `BlueprintRetentionTier`, `RetentionRun`, `RetentionRunKind`, with the
  relationship lines `RetentionPolicy ||--o{ RetentionPolicyTier`, `User ||--o{ UserRetentionTier`,
  `UserDevice ||--o{ DeviceRetentionTier`, `UserDeviceAction ||--o{ ActionRetentionTier`,
  `Blueprint ||--o{ BlueprintRetentionTier`, `RetentionRun ||--o{ RetentionRunKind`,
  `User ||--o{ RetentionRun : "requested"`, and a line from `RetentionBucket` to each of the five
  tier tables plus `SensorRollup` and `RetentionPolicy`.
- **Table reference**: a `####` entry per new table, **edits to two existing entries**, and **one
  deletion** —
  - `sensor_rollup` (line ~1146) currently says the bucket is `"hour"`/`"day"`: rewrite to the
    elastic vocabulary, note the FK into `retention_buckets`, and state that a coarse bucket is
    folded from the next finer one, never from raw;
  - `retention_policy` (~1185): drop **all six** day columns from the prose, add
    `min_bucket`/`max_tiers` and the tier-list layer;
  - `user_retention_preferences` (~1194): **delete the entry** — the table is dropped, and
    `user_retention_tiers` takes its place.

---

## 2. The pure, DB-free core

### 2.1 A new shared package: `packages/retention` (`@lattice/retention`)

`resolveTiers` and the tier arithmetic are needed by **both** `services/api` (validation, selection,
display) and `services/automation-worker` (rollup, prune). The convention is explicit: _logic used
by ≥2 services belongs in a package, not copied_ (`docs/CONVENTIONS.md`). Phase 1 already had to
duplicate the clamp — `services/api/src/services/retention.service.ts::effective()` is documented as
"Mirror of the worker's clamp, for display only". Deleting that duplicate is part of this step.
Precedent: `@lattice/params`.

| module           | contents                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/kinds.ts`   | `DataKind`, `DATA_KINDS`, `isDataKind`, `RAW_SECONDS`, `RAW_BUCKET` — the two facts every other module needs, kept apart so the graph is a tree rather than a ring                                                                                                                                |
| `src/buckets.ts` | `BucketDef`, **`bucketStart(d, seconds, anchorOffset)`**, `hourStart`/`dayStart` (thin wrappers over it), `isBucketAdmissible`, `assertBucketAdmissible`, `allowedForKind`, `whyNotAllowedForKind`, `formatSeconds`, `describeSeconds` — **no hard-coded code list**; the catalog arrives as rows |
| `src/tiers.ts`   | **`resolveTiers(...)`**, `assertTierList(...)`, `assertChainDivisible(...)`, `TIER_SCOPES`                                                                                                                                                                                                        |
| `src/windows.ts` | `clampKeepDays`, `clampDays`, `pruneCutoff`, `aboveCeiling`, `assertWithinCeiling`, `rawFloorDays`/`MIN_RAW_KEEP_DAYS` — plus Phase 1's `resolveRetention` and its three types, kept only until Step 2 drops the columns they describe                                                            |
| `src/fold.ts`    | `Bucket`, `emptyBucket`, `foldReading`, `bucketAvg` (moved) **plus new `foldRollup(acc, row)`**                                                                                                                                                                                                   |
| `src/select.ts`  | **`selectTier(...)`** — the replacement for `selectBucket`                                                                                                                                                                                                                                        |

Both old modules are deleted; `hourStart`/`dayStart` survive as one-line wrappers over
`bucketStart(d, 3600)` / `bucketStart(d, 86400)` — identical output, since epoch-multiple flooring
of 3600s and 86400s lands exactly on the UTC hour and UTC midnight, which the unit suite pins.

`bucketStart` takes **seconds, not a code**: a resolved tier already carries its size and its anchor,
so the worker never goes back to the catalog per action. That is the N+1 the extraction exists to
avoid, and it is why `ResolvedTier` is a wider shape than the row it came from.

Add `@lattice/retention` to the root `build:libs` chain (a protected script — the concrete verified
reason is that a package must build before its consumers) and to the `tsconfig` project references.

### 2.2 `resolveTiers` — the scope chain

```ts
export type TierScope = 'action' | 'device' | 'blueprint' | 'user' | 'platform';

export interface TierRow {
  bucket: string;
  keep_days: number;
  position: number;
}
export interface PlatformTierRow extends TierRow {
  max_keep_days: number | null;
}

export interface ScopedTierLists {
  action?: TierRow[];
  device?: TierRow[];
  blueprint?: TierRow[];
  user?: TierRow[];
  platform: PlatformTierRow[];
  limits: { minBucket: string; maxTiers: number; dataKind: string; enabled: boolean };
}

export interface ResolvedTier {
  bucket: string;
  seconds: number;
  keepDays: number;
  ceilingDays: number | null;
  effectiveDays: number;
}
export interface ResolvedTiers {
  tiers: ResolvedTier[]; // ascending by size, deduped, validated
  source: TierScope; // which scope supplied the list
  rejected: { bucket: string; reason: string }[]; // never silent
}

export function resolveTiers(lists: ScopedTierLists): ResolvedTiers;
```

Rules, decided here and **nowhere else** — the resolution order is the whole feature and it is
exactly the kind of thing that rots if each caller re-implements it:

1. **The whole LIST wins, not individual tiers.** The most specific scope with _any_ rows for this
   `data_kind` supplies the entire list. Tier-level merging would make F18.12's acceptance test
   ambiguous — "removing it falls back to the device's" means the device's _list_, not the device's
   version of that one bucket.
2. Order: `action` → `device` → `blueprint` → `user` → `platform`. Platform always exists (a missing
   row means keep-forever, per Phase 1's `loadPolicies` fallback).
3. Each tier's `keep_days` is clamped against the **platform row for the same bucket** via the
   existing `clampDays` — `0` is forever and therefore loses to any finite ceiling.
4. A bucket finer than `limits.minBucket`, or not in `ALLOWED_BUCKETS_BY_KIND[dataKind]`, is dropped
   into `rejected` with a reason so the API can explain it.
5. Sorted ascending by `seconds`; duplicates collapsed (finest position wins).
6. Longer than `maxTiers` is **refused at write time** by `assertTierList`; the resolver truncates
   only as a defence, dropping from the **fine end** — the coarse tiers are what the long-range
   chart depends on, and silently losing them would break reads rather than cost storage.

`assertTierList(tiers, limits)` is the write-time twin: throws `{ statusCode: 400 }` with a message
naming the offending bucket and the limit, the same shape `assertDefaultWithinCeiling` already uses.

### 2.3 `selectTier` — the replacement for `selectBucket`

```ts
export function selectTier(
  tiers: ResolvedTier[],
  from: Date,
  to: Date,
  opts: { requested?: string; rawDays: number; now: Date; minPoints?: number; maxPoints?: number },
): { bucket: 'raw' | string; reason: 'requested' | 'auto' | 'fallback' };
```

Candidates are `raw` plus the configured tiers ascending. For each:

1. **Drop what retention no longer holds** — a tier whose `effectiveDays` window does not reach back
   to `from` has no rows there. (`0` = forever always covers.) Phase 1's comment already worried
   about this for raw; now it is enforced for every tier.
2. **Drop what is too many points** — `(to - from) / seconds > maxPoints` (default 5000). Raw keeps
   the existing 48-hour rule.
3. Among survivors, take the **coarsest whose point count is still ≥ `minPoints`** (default 60). If
   nothing reaches `minPoints` the range is very short — take the finest survivor.
4. `requested` is honoured when it is a configured tier that survives (1) and (2); otherwise it is a
   request, not a command, and auto wins.

The consequence F18.9's acceptance criterion asks for: an admin adds a `15m` tier and the chart
picks it up **without a code change**, because the candidate set is data.

`services/api/src/services/history-bucket.ts` shrinks to `resolveRange` + `clampLimit` (transport
shaping, not retention arithmetic) and re-exports `selectTier` so `history.service.ts` keeps one
import.

### 2.4 `foldRollup` — building a coarse bucket from a fine one

```ts
export function foldRollup(
  acc: Bucket,
  row: {
    sample_count: number;
    numeric_count: number;
    error_count: number;
    min_value: number | null;
    max_value: number | null;
    avg_value: number | null;
    last_value: string | null;
  },
): Bucket;
```

Sums counts, mins the mins, maxes the maxes, and accumulates `sum += avg_value * numeric_count` so
the parent's average is computed from **counts, not from an average of averages** — which is the
only way a 1d bucket over unevenly-sampled hours comes out right. `last_value` takes the latest
child's, so callers must feed rows in ascending `bucket_start`, the same contract `foldReading`
already documents.

### 2.5 Test files

| module                                    | test file                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `tiers.ts`, `buckets.ts`, `fold.ts`       | **`tests/unit/history.retention-tiers.test.ts` (new)**                          |
| `select.ts` + `resolveRange`/`clampLimit` | `tests/unit/history.bucket-select.test.ts` (extended)                           |
| `windows.ts`                              | `tests/unit/history.retention-logic.test.ts` (imports move; F18.11 cases added) |

---

## 3. Worker changes (`services/automation-worker`)

### 3.1 Loop shape — resolve once, in memory

The current rollup already groups by action; `pruneHistory` groups by **user**. Per-action tiers
would turn that into an N+1 if each action asked the DB for its chain. It must not.

New `loadTierIndex(scopeUserId?)` does **one pass of six cheap queries** and returns
`Map<actionId, ResolvedTiers>`:

- `retention_policy` + `retention_policy_tiers` (a handful of rows),
- `user_retention_tiers` grouped by user,
- `blueprint_retention_tiers` grouped by `(blueprint_id, slot_key, action_name)`,
- `device_retention_tiers` grouped by device, `action_retention_tiers` grouped by action,
- the action → device → user map,
- the device → `(blueprint_id, slot_key)` map from `blueprint_slot_bindings` (which is
  `@@unique([user_device_id])`, so one row per device).

Then `resolveTiers` runs **per action with no I/O**. That is the payoff of extracting the resolver.

### 3.2 `rollUpScalars` — ascending, each tier from the next finer one

```
for each action with raw rows in the window:
  tiers = index.get(actionId)                  // ascending by size; skip if empty
  buildFromRaw(action, tiers[0])               // ONLY the finest tier reads sensor_history
  for i = 1 .. tiers.length-1:
     buildFromTier(action, tiers[i], tiers[i-1])   // sensor_rollup → sensor_rollup
```

- Wide tiers never re-scan raw. A `1w` tier built from raw would read a week of 10-second readings
  per action per night; built from `1d` it reads seven rows.
- **Per-tier window.** `until = bucketStart(now, tier.bucket)` — exclusive, because the bucket we
  are inside is still filling and the upsert would freeze a wrong number until something recomputed
  it. `since = until − max(lookbackDays·86400, LOOKBACK_PERIODS · tierSeconds)` with
  `LOOKBACK_PERIODS` default 2. **Without the second term a `1w` tier is never built at all** under
  the current 3-day lookback — the last completed week starts further back than that. New env
  `RETENTION_LOOKBACK_PERIODS`.
- Reading the finer tier hits `(user_device_action_id, bucket, bucket_start)` head-on — it is
  exactly the unique index.
- Upserts keep their existing shape, so the whole pass stays idempotent: a re-run, a missed night,
  or a crash halfway self-heals.
- `rollUpCommands` and `rollUpAvailability` are unchanged in shape (their tables are `DATE`-keyed,
  one tier by construction).

### 3.3 Pruning (F18.10)

`pruneHistory(now, ctx, scopeUserId?)`:

- **Raw tables** — unchanged in policy (per user, per kind, from `resolveRetention`), but now
  honouring `scopeUserId` and using the bounded delete below.
- **`sensor_rollup`** — per `(action, bucket)`:
  `DELETE … WHERE user_device_action_id = ? AND bucket = ? AND bucket_start < cutoff`, where
  `cutoff = pruneCutoff(tier.effectiveDays, enabled, now)` and a `0` tier yields `null` → nothing
  deleted (F18.10's "a `0` tier keeps them forever").
- **Orphan sweep** — `DELETE … WHERE user_device_action_id = ? AND bucket NOT IN (configured buckets)`.
  This is what makes "a user drops to two tiers → both sweeps prune to exactly those tiers"
  actually true; without it a removed tier's rows sit forever and the chart can still find them.
- **`command_rollup_daily`** — the `command` kind's `1d` tier, per action id (index
  `(user_device_action_id, day)`).
- **`device_availability_daily`** — the `device_event` kind's `1d` tier, per device (index
  `(user_device_id, day)`).

**Batching.** Today's cap is checked _before_ a `deleteMany`, which decides whether to start a
delete, not how big it is — a single statement can still delete millions of rows holding one long
lock. Prisma's `deleteMany` has no `LIMIT`, so each delete becomes a bounded loop through
`db.$executeRaw`:

```sql
DELETE FROM sensor_rollup WHERE id IN (
  SELECT id FROM sensor_rollup
  WHERE user_device_action_id = $1 AND bucket = $2 AND bucket_start < $3
  ORDER BY id LIMIT $4
)
```

repeated until it returns 0 or the per-kind cap (`RETENTION_DELETE_BATCH`) is reached. New env
`RETENTION_DELETE_CHUNK` (default 5000). Whatever is left goes tomorrow — being a night late costs
nothing next to a lock over a million rows while rules are evaluating.

**Bytes reclaimed.** For frames, `SELECT SUM(byte_size)` over the chunk immediately before deleting
it → `bytes_estimated = false`. Everywhere else, rows × the same per-row constants the usage panel
already uses (`READING_BYTES` 48, `COMMAND_BYTES` 180, `EVENT_BYTES` 120) → `bytes_estimated = true`,
labelled as such in the UI the way the usage panel already labels its figures.

### 3.4 Run lifecycle + the two-level lock

New `services/automation-worker/src/services/retention-run.ts`:

- `claim(trigger, requestedBy, scopeUserId)` — inserts a `retention_runs` row whose `lock_key` is
  `'global'` for a platform sweep (cron or admin) and `'user:<id>'` for a user sweep. The column is
  `UNIQUE` and nullable, held from `queued` until terminal and then set NULL — Postgres's
  NULL-distinct rule as the feature, for once.
- A unique key alone is **not enough**: a user sweep and a platform sweep would still overlap on the
  same rows while holding different keys. So every claim runs inside a transaction guarded by
  `pg_advisory_xact_lock(RETENTION_LOCK_ID)`, which makes "is anything conflicting active?" and the
  insert atomic.

| claiming               | refused while                                                      |
| ---------------------- | ------------------------------------------------------------------ |
| global (cron or admin) | **any** run is active — global or any user                         |
| user _N_               | a global run is active, or `user:N` is                             |
| user _N_               | _(not refused by `user:M`, M≠N — disjoint, ownership-scoped rows)_ |

A global claim that loses inserts its row as `queued` anyway, which blocks new user claims, and
waits for in-flight user runs before going `running` — **writer preference**, so the nightly pass
cannot be starved by a stream of user Applies. User sweeps are additionally rate-limited to one per
user per 15 minutes; without that, "Apply" is a free denial-of-service on the shared worker.

- `reapStale(now)` — `queued`/`running` rows older than `RETENTION_RUN_STALE_MS` (default 6h) become
  `failed` with `error = 'abandoned — worker restarted or the request dead-lettered'` and
  `lock_key = NULL`. Run at worker startup and before every claim, so a killed worker cannot wedge
  the feature. This also covers the DLQ case: every static queue is asserted with
  `x-message-ttl: 300000`, so an Apply published while automation-worker is down dead-letters after
  five minutes, and the reaper turns it into a _failed run with a readable error_ rather than a
  request that silently vanished.
- `phase(runId, name)`, `recordKind(runId, kind, counters)`, `finish(runId, status, error?)` — the
  last one always in a `finally`, always clearing `lock_key`.

`runRetentionPass({ runId?, trigger, scopeUserId, now })` becomes run-aware and scope-aware; the
cron calls it with `trigger: 'cron', scopeUserId: null`.

New `services/automation-worker/src/consumers/retention-sweep.consumer.ts`: consumes
`QUEUES.RETENTION_SWEEP`, takes over the row named by `runId` with a compare-and-set
(`status: 'queued' → 'running'`; 0 rows affected means someone else has it → ack and return), then
runs the pass. **The scope is re-read from the row, never from the payload** — the queue message is
a wake-up, not an authority. On error it records the error on the row and **re-throws**, so
`consume()` nacks to the DLQ per repo convention.

### 3.5 Event contract (`packages/queue`) — never ad-hoc strings

- `RK.RETENTION_SWEEP_REQUESTED = 'retention.sweep.requested'`
- `QUEUES.RETENTION_SWEEP = 'q.retention.sweep'`
- add the pair to `STATIC_QUEUE_BINDINGS` in `packages/queue/src/index.ts`
- `RetentionSweepRequestedPayload { runId: number; trigger: 'admin' | 'user'; requestedByUserId: number; scopeUserId: number | null }`
  in `src/types.ts`, its zod schema in `src/schemas.ts`, and canonical/mutation fixtures in
  `tests/unit/platform.queue-contracts.test.ts` (that suite enumerates every `RK`, so it fails the
  build until the schema exists — which is the point).
- `NOTIFICATION_EVENT_TYPES` in `packages/queue/src/notifications.ts` gains `'retention_trimmed'`,
  with a template in `services/notification-service/src/delivery/templates.ts`.

**Note the DLQ TTL.** Every static queue is asserted with `x-message-ttl: 300000`. An Apply
published while automation-worker is down dead-letters after five minutes. That is precisely why the
API creates the row as `queued` and the staleness reaper turns it into a `failed` run with a
readable error — the page says "the worker never picked this up" instead of the request silently
vanishing.

### 3.6 New env (`services/automation-worker/src/config/env.config.ts`)

`RETENTION_LOOKBACK_PERIODS` (2), `RETENTION_DELETE_CHUNK` (5000), `RETENTION_RUN_STALE_MS`
(21600000). Policy stays in the DB, as the existing comment insists — what lives here is the shape
of the job, not the policy it enforces.

---

## 4. API + routes

### 4.1 Service (`services/api/src/services/retention.service.ts`)

All new methods are service-level; nothing below touches `routes/`.

- `listPolicies()` — now returns `tiers: [{ bucket, keepDays, maxKeepDays, position }]`, `minBucket`,
  `maxTiers` per kind.
- `setPolicyTiers(adminId, kind, tiers[])` — replace-the-list inside one transaction (`deleteMany` +
  `createMany`), gated by `assertTierList`. When a `max_keep_days` drops, it returns the count of
  users now over the new limit (F18.16 input).
- `myTiers` / `setMyTiers` / `resetMyTiers` — reset **deletes** the rows so the user follows future
  default changes, the same rule `resetMine` already documents.
- `deviceTiers` / `setDeviceTiers`, `actionTiers` / `setActionTiers` — ownership-checked (see §6).
- `blueprintTiers` / `setBlueprintTiers` — admin only.
- `effectiveTiers(userId, actionId)` — runs `@lattice/retention.resolveTiers` over real rows and
  returns `{ tiers, source, rejected }` so the UI can say _where_ a tier came from and why one was
  refused.
- **`setMyTiers` (F18.11)** — compares each tier's `keep_days` against that bucket's
  `max_keep_days` via the shared
  `assertWithinCeiling` and throws a 400 naming the ceiling, instead of storing a value only the
  worker's clamp will quietly correct. `mine()` gains the tiers' defaults/ceilings/effective values
  the way it already does for raw.
- `previewSweep(scopeUserId | null)` — counts (not deletes) what the current configuration would
  remove, so the confirmation dialog can name real numbers.
- `requestSweep(requestedByUserId, scope)` — creates the `queued` row (claiming the singleton),
  publishes `RK.RETENTION_SWEEP_REQUESTED` through `getChannel()`, returns the row. If the publish
  throws, the same catch marks the row `failed` and releases the singleton, so a broker outage does
  not wedge the feature.
- `runs(limit, before)` / `run(id)` — admin job history. `myRuns(userId)` / `myRun(userId, id)`
  filter on `scope_user_id = userId`.

### 4.2 Routes (`services/api/src/routes/retention.routes.ts`) — thin delegates

```
user  router (requireAppToken)
  GET    /api/retention/tiers                  → myTiers(req.user.id)
  PUT    /api/retention/tiers/:kind            → setMyTiers(req.user.id, kind, body)
  DELETE /api/retention/tiers/:kind            → resetMyTiers(req.user.id, kind)
  GET    /api/retention/preview                → previewSweep(req.user.id)
  POST   /api/retention/apply                  → requestSweep(req.user.id, { scopeUserId: req.user.id })
  GET    /api/retention/apply/:id              → myRun(req.user.id, id)

admin router (requireAppToken, requireAdmin)
  PUT    /api/admin/retention/:kind/tiers      → setPolicyTiers
  GET    /api/admin/retention/preview          → previewSweep(null)
  POST   /api/admin/retention/apply            → requestSweep(req.user.id, { scopeUserId: null })
  GET    /api/admin/retention/runs             → runs
  GET    /api/admin/retention/runs/:id         → run
  GET/PUT/DELETE /api/admin/blueprints/:id/retention-tiers

device/action routers: GET/PUT/DELETE /api/devices/:id/retention-tiers, /api/actions/:id/retention-tiers
```

Every handler is `try { res.json(await retentionService.x(...)) } catch (err) { next(err) }`. No
loops, no `db.` calls, no branching on business state.

### 4.3 Why out-of-band, not inline (F18.13)

1. It deletes millions of rows. An HTTP request cannot own that — ingress and proxy timeouts fire
   long before it finishes, and a client retry would try to start a second sweep.
2. `api` is the request-serving process. An hours-long DB job in it starves the connection pool
   every user shares.
3. The worker already owns the pass, its batching, its env knobs and its cron. A second
   implementation in `api` is exactly what the "logic lives in one place" rule exists to prevent.
4. Single-flight is only checkable where the cron lives — and the cron lives in the worker.

### 4.4 The single-flight guarantee — four layers

| layer         | mechanism                                                                                           | what it stops                                                       |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| authoritative | `retention_runs.lock_key` UNIQUE + nullable — `'global'` or `'user:<id>'`, held `queued` → terminal | two admins, admin-vs-cron, one user pressing twice, across replicas |
| gate          | `pg_advisory_xact_lock` around every claim, with the conflict table in §3.4                         | a user sweep overlapping the platform sweep on the same rows        |
| scheduler     | the cron takes the same global claim; a losing cron logs and skips the night                        | cron starting on top of an in-flight admin sweep                    |
| recovery      | `reapStale` on startup and before every claim                                                       | a killed worker holding a key forever                               |

Two user sweeps for **different** users run concurrently by design — they touch disjoint,
ownership-scoped rows, and serialising them would make one user's Apply wait on a stranger's.

A second press returns **409** naming the running run's trigger and `started_at` — _refused, not
queued_, which is what the acceptance criterion asks for.

### 4.5 Progress reporting

The page polls `GET …/runs/:id` every 2s while a run is not terminal. The worker writes `phase` and
the per-kind counters as each stage completes, so progress is real rather than a spinner. A socket
event was considered and rejected for now: it means a new entry in the event contract for a screen
two people look at, and polling a two-column read of one row costs nothing.

---

## 5. Backoffice

- **`services/retention.service.ts`** — new view types (`TierView`, `ResolvedTierView`,
  `RetentionRunView`, `SweepPreview`), the new calls, and a `formatBucket()` beside the existing
  `formatDays`/`formatBytes`.
- **Admin tier editor** — `admin-retention/tier-editor.component.ts`, embedded in the existing
  `admin-retention` page below each kind's raw window. One row per tier (bucket select filtered by
  `minBucket`, keep-days chips reusing the existing `CHOICES`, position controls), an add button
  disabled at `maxTiers`, and a live cost line — `86400 / bucketSeconds` rows per sensor per day —
  because `min_bucket = '5m'` on a 10-second sensor produces more rollup rows than some raw windows
  keep. Save is one PUT that replaces the list.
- **Job-history page** — `admin-retention-runs/`, route `admin/retention/runs` with
  `[authGuard, adminGuard]`, modelled on `pipeline-run-history`. Columns: started, trigger, who,
  scope, duration, buckets written, rows deleted, bytes reclaimed, status. Expandable per-kind
  breakdown; a failed run shows its error inline rather than vanishing. Bytes labelled _measured_
  for frames and _estimated_ elsewhere.
- **Apply-now dialog** — `retention-apply-dialog.component.ts`, following the
  `admin-device-config/confirm-dialog` + `device-update-dialog` pattern already in the codebase. It
  names what will be removed (from `preview`), states plainly that it is irreversible, and only then
  enables the confirm button. On confirm it POSTs and swaps to a progress panel polling the run. A
  409 renders "a sweep started by _X_ at _HH:MM_ is still running" — not a generic failure toast.
- **User-facing (F18.15)** — `user-settings` gains the same tier editor (ceilings from `mine()`,
  over-ceiling chips already render disabled via the existing `exceedsCap`) plus an "Apply my new
  configuration" button opening the same dialog with _their_ preview numbers. The copy must state
  three things: it is irreversible, here are the row counts about to be deleted, and it touches only
  your own data.
- **Angular unit specs (vitest)** for the service mapping and the tier-editor's validity rules.
  `docs/TESTING.md` requires specs for services/stores; component DOM specs are not required.

---

## 6. Security boundaries (explicit)

1. **`scopeUserId` is never user-supplied.** The user route passes `req.user!.id` positionally;
   `requestSweep`'s signature has no parameter a request body could reach. The queue payload's
   `scopeUserId` is written by the API from the authenticated principal, and the worker **re-reads
   it from the `retention_runs` row** rather than trusting the message — the message is a wake-up,
   not an authority.
2. **One ownership filter, shared with the read API.** The worker's user-scoped queries go through a
   single `ownedActionIds(userId)` = `user_device_action where user_device.user_id = userId` — the
   same shape as `history.service.ensureActionOwned`. `device_commands` / `device_events` filter on
   their own `user_id` column, exactly as `historyService.commands` does.
3. **Extract, don't copy.** `ensureActionOwned` / `ensureDeviceOwned` move out of
   `history.service.ts` into `services/api/src/services/ownership.ts` and are imported by both.
   Retention must not grow a second ownership implementation that can drift.
4. Device/action tier writes return **404 for missing, 403 for not-yours** — the same codes the read
   API returns, so an id probe learns nothing it did not already know.
5. **Blueprint tiers are admin-only** (`requireAdmin`). A user cannot edit the definition their
   instance inherits from.
6. **A user cannot read a platform sweep.** `myRuns`/`myRun` filter on `scope_user_id = userId`; a
   platform run's counters leak other users' data volumes.
7. **Rate limit.** One user-triggered sweep per user per `RETENTION_USER_APPLY_COOLDOWN_MS` (default
   15 min), enforced in the service against the user's last run. Without it, "Apply" is a free
   denial-of-service on the shared worker.

---

## 7. Test plan (`docs/TEST-PLAN.md` updated in the same change)

`tests/unit/platform.test-plan-sync.test.ts` fails the build on drift **in either direction** — an
unimplemented ✅ case, an unplanned test, or an unlisted file. Add the cases to the plan _first_; the
bullet text is the exact test title.

### New — `tests/unit/history.retention-tiers.test.ts` — **written, 57 cases**

The case list lives in **`docs/TEST-PLAN.md`**, not here: `platform.test-plan-sync.test.ts` parses
that file and fails the build when a planned case has no test or a test is not planned, in either
direction. A second copy of the list in this document would be the only unchecked one, and would be
the one that went stale.

What the suite covers, by block:

- **`bucketStart`** — that the generic `floor((epoch − a) / s) * s + a` reproduces Phase 1's
  `hourStart`/`dayStart` exactly; that a custom `90m` floors onto 00:00 / 01:30 / 03:00 and starts
  every day at midnight; that `1w` truncates to Monday via its anchor rather than the epoch's
  Thursday; and that flooring onto `raw` throws instead of dividing by zero into an Invalid Date.
- **Admission** — `90m` accepted (16 to a day), `7h` refused with "try 6h or 8h", sub-minute and
  fractional sizes refused.
- **Per-kind limits** — scalar anything, command/event whole days only, frame raw only, and every
  kind may keep raw.
- **`assertTierList`** — the chain rule (`raw → 15m → 90m → 1d` accepted, `90m` above `1h` refused
  naming 1.5× and suggesting 30m or 45m), the mandatory raw row, `max_tiers`, `min_bucket` (which
  never binds raw), per-tier ceilings, and **the raw floor** including its two-day minimum and the
  case where a list with no rollup tier is exempt.
- **`resolveTiers`** — all five scopes in order, whole-list inheritance, the fallback when the most
  specific list is deleted, per-bucket clamping (forever included), rejection reasons, sorting and
  position renumbering.
- **`foldRollup`** — averaging from counts rather than averaging averages, and the property that
  makes the whole chain trustworthy: a parent folded from children equals the parent folded from the
  readings.

### Extended — `tests/unit/history.bucket-select.test.ts`

Keep the existing `resolveRange`/`clampLimit` bullets; replace the `selectBucket` ones with:

```
- picks the coarsest tier that still has enough points
- picks a finer tier when the coarse one would draw too few points
- skips a tier whose retention no longer covers the range
- falls back to raw when no tier covers the range
- refuses raw when the range is wider than raw retention
- honours a requested tier that is configured
- ignores a requested tier that is not configured
- picks a 15-minute tier once one is added, with no code change
```

### Extended — `tests/unit/history.retention-logic.test.ts`

Imports move to `@lattice/retention`; add the F18.11 cases (`rejects a user window above the ceiling`,
`names the ceiling in the refusal`, `accepts a window at the ceiling`).

### Contract + notifications

`platform.queue-contracts.test.ts` (new RK fixtures) and `platform.notifications.test.ts` (the
`retention_trimmed` default matrix) — both suites enumerate their catalogs, so they fail until
updated.

### Integration — `tests/integration/history.retention.integration.test.ts`

```
- folds a 1h tier from raw and a 1d tier from the 1h tier, never from raw
- prunes each tier on its own window
- keeps a 0 tier forever
- deletes rollup rows for a bucket that is no longer configured
- refuses a second sweep while one is running
- a user-scoped sweep leaves another user's rows untouched
```

⚠️ `docs/TESTING.md` currently scopes integration suites to digest-service, ml-router and
action-migration ("do **not** add integration suites for thin adapter services"). automation-worker's
retention pass is genuinely complex DB logic, but adding this suite means **editing that sentence in
the same change** — or covering it e2e only. Flagged as a decision, not assumed.

### E2E — `tests/e2e/history.retention-apply.e2e.test.ts`

Admin lowers a ceiling → Apply → the run reaches `ok` and the over-limit rows are gone; a second
press while running returns 409.

### Also update in the same change

`docs/TESTING.md` file-map block; `SYSTEM-DESIGN-ROADMAP.md` rows F18.9–F18.16 plus a session-log
entry.

---

## 8. Build order, with stop-for-review points

**Step 0.** Phase 1 is committed (`a8315f9`). Nothing here starts on an uncommitted tree — this
migration alters columns Phase 1's migration just created.

**Step 1 — `@lattice/retention`, pure only. ✅ BUILT 2026-08-24.** `retention-logic.ts` and
`retention-rules.ts` moved in and deleted; `kinds`, `buckets`, `tiers`, `fold`, `select` added;
`build:libs`, the root tsconfig references and both service `package.json` files wired; the API's
duplicated `effective()` clamp replaced by the shared `clampKeepDays`; `history.retention-tiers.test.ts`
(57 cases) added and `history.bucket-select.test.ts` extended with the `selectTier` ladder (11), with
TEST-PLAN entries generated from the test titles so they cannot drift.
→ **STOP FOR REVIEW.** This is where the resolution order, the vocabulary and the raw floor get
argued about, and everything after is mechanical. Nothing behavioural changed: the package is pure,
`hourStart`/`dayStart` floor to the same instants, and the old call sites behave identically.

**Step 2 — schema + migration + SCHEMA.md.** **Eight** tables (the catalog plus five tier tables
plus two job tables), the fold, the `sensor_rollup` vocabulary rewrite, the FK that validates it,
six columns dropped and one table dropped. `prisma migrate dev` locally, re-seed, confirm the API
reads existing rollups back unchanged.
→ **STOP FOR REVIEW.** A migration that drops a table and rewrites a data column does not get
bundled with feature code. Verify against a copy of real data — and rehearse the _failure_: leave
one row as `'hour'` deliberately and confirm the FK makes the migration refuse.

**Step 3 — worker: rollup chain + tier pruning + bounded deletes.** No API surface; the nightly cron
alone. Verify on the dev stack with a hand-inserted `15m` tier.
→ **STOP FOR REVIEW.** This is the destructive half.

**Step 4 — run rows, the two-level lock, sweep consumer, queue contract.** Still no UI — exercised by
publishing the RK by hand.
→ **STOP FOR REVIEW.**

**Step 5 — API.** Bucket catalog CRUD (any user may add a size), tier CRUD at all five scopes,
F18.11 ceiling rejection, preview/apply/runs, ownership extraction.

**Step 6 — Backoffice.** Tier editor, **custom-bucket dialog**, apply dialog, job-history page,
user-facing apply.

**Step 7 — F18.16.** Ceiling-drop detection, notification event type + template, the recorded
decision.

**Step 8 — docs sweep.** TEST-PLAN.md, TESTING.md, roadmap rows + session log.

---

## 9. Risks and underspecified points

1. **The `sensor_rollup` vocabulary rewrite is a data migration, not a code change.**
   `'hour'`/`'day'` → `'1h'`/`'1d'` must land in the same migration or every bucket ever written
   becomes invisible and is immediately orphan-pruned. Not mentioned in the roadmap row; the single
   most dangerous line here. (Verified: `retention.service.ts:129-130` writes the literals and
   `history-bucket.ts:5` types them.)
2. **Week alignment.** Epoch-multiple flooring puts `1w` boundaries on a Thursday (1 Jan 1970 was
   one). Recommend Monday-UTC. Either way it must be one function shared by writer and reader, or
   buckets will not line up.
3. **Rollup blow-up.** A `5m` tier on a 10-second sensor is 288 rollup rows/day/sensor — more rows
   than some raw windows keep. `min_bucket` is the admin's brake, but it defaults to `raw` (no
   floor), so the real defence is the **live cost line** in the tier editor: `86400 / bucketSeconds`
   rows per sensor per day, shown as the size is chosen. A user adding a custom `90m` sees 16/day; a
   user reaching for `5m` sees 288 before they commit to it.

---

## 10. Open questions — answered 2026-08-24

All seven were put to the user and answered. The answers are recorded at the top of this document;
the three that overrode what this plan originally proposed are marked below.

1. **Is `raw` a tier?** → **Yes, position 0.** _(Overrode the proposal, which kept `raw_days`
   kind-level. §1.1/§1.2/§1.4 rewritten.)_
2. **List-level inheritance?** → **Confirmed**: the most specific scope with any rows supplies the
   entire list.
3. **How is "no rollups for this sensor" spelled?** → **A tier list of `raw` alone.** The proposed
   `bucket = 'none'` sentinel is dropped — with raw in the list it has no reason to exist.
4. **One global single-flight key, or per-user?** → **Per-user keys plus a global gate.**
   _(Overrode the proposal. §3.4/§4.4 rewritten.)_
5. **F18.16 — grace period or immediate?** → **Trimmed at once, and notified.** Recorded in the
   roadmap row, which that row explicitly requires.
6. **Blueprint scope addressing?** → **Confirmed**: `(blueprint_id, slot_key, action_name)`.
7. **Integration-tier scope.** → Still open, and deliberately: it is a Step 3/4 question, and
   `docs/TESTING.md` is edited in the Step 8 docs sweep either way. The e2e in §7 covers the
   behaviour regardless of how it resolves.

One further decision arrived with the answers and was not on this list: **the bucket vocabulary is a
user-extensible table** rather than a fixed list in code. §1.1 was rewritten for it.
