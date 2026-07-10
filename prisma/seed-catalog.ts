// Populates the master device catalog from the firmware-generated manifests in
// ESP32Code/tools/manifest-gen/out/*.json.
//
// This is the build-driven replacement for the old device-driven catalog write: the
// manifest comes from firmware SOURCE (via the host generator), not from a live device
// provisioning itself. Locally the catalog is freely re-seeded; in prod the same JSON is
// ingested through an authenticated CI path (kept append-only there).
//
//   node tools/generate-manifests.mjs   (in ESP32Code/, writes the JSON)
//   npm run catalog:seed                 (runs the generator, then this script)
//
// Schema note (F1.5/F1.7): a DeviceCapability (device_capabilities) no longer
// stores pins/traits/google type inline. They live in child tables:
//   - device_capability_pins   (key, label, mode)         ← manifest configurable_pins
//   - device_capability_traits (→ google_device_traits)   ← manifest google_traits
//   - google_type_id FK        (→ google_action_types)    ← manifest google_action_type
// Google types/traits are upserted by `value` here so the catalog self-populates even if
// seed.ts didn't list a firmware-declared value; existing (nicely named) rows are kept.
//
// A trait's accepted-value constraint (google_device_traits.valid_parameters) comes straight
// off the manifest's google_traits[].constraint — declared once per trait in firmware
// (ESP32Code/src/actions/manifest/GoogleTraits.h) alongside the action classes that already
// enforce it (BaseCommandAction's validParameters/range), not guessed here from the trait name.
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';

// ts-node runs this in CommonJS mode (no "type":"module"), so __dirname is available.
// Load root .env so DATABASE_URL is available when running via plain ts-node (not prisma db seed).
dotenvConfig({ path: join(__dirname, '..', '.env') });

const manifestDir = join(__dirname, '..', 'ESP32Code', 'tools', 'manifest-gen', 'out');

// Mirrors GoogleTraitDef's constraint shape (ESP32Code ActionPinsSetup.h) as serialized by
// CapabilitySerializer.h: an enum of accepted string values, or a numeric range.
type TraitConstraint =
  { type: 'enum'; values: string[] } | { type: 'range'; min: number; max: number; step?: number };

interface GoogleTraitManifestEntry {
  value: string;
  label: string;
  constraint?: TraitConstraint;
}

interface CapabilityManifestEntry {
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  google_action_type: string | null;
  min_telemetry_interval_ms: number | null;
  google_traits: GoogleTraitManifestEntry[];
  configurable_pins: { key: string; label: string; mode: string }[];
  configurations?: { behavior: string; min_interval_ms?: number }[];
}

interface DeviceManifest {
  deviceType: string;
  version: string;
  capabilities: CapabilityManifestEntry[];
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function loadManifests(): DeviceManifest[] {
  if (!existsSync(manifestDir)) {
    throw new Error(
      `No manifests at ${manifestDir}. Run: (cd ESP32Code && node tools/generate-manifests.mjs)`,
    );
  }
  const files = readdirSync(manifestDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0)
    throw new Error(`No *.json manifests in ${manifestDir}. Run the generator first.`);
  return files.map((f) => JSON.parse(readFileSync(join(manifestDir, f), 'utf8')) as DeviceManifest);
}

// Last dotted segment, e.g. 'action.devices.types.OUTLET' → 'OUTLET'. Used only as a
// fallback display name when the value isn't already seeded with a friendlier one.
function fallbackName(value: string): string {
  return value.split('.').pop() ?? value;
}

// Upsert by `value`, preserving any existing (friendlier) name; returns the row id.
// The no-op DO UPDATE lets RETURNING fire on the conflict path too.
async function upsertGoogleActionType(client: pg.PoolClient, value: string): Promise<number> {
  const res = await client.query<{ id: number }>(
    `INSERT INTO google_action_types (name, value) VALUES ($1, $2)
     ON CONFLICT (value) DO UPDATE SET value = EXCLUDED.value
     RETURNING id`,
    [fallbackName(value), value],
  );
  return res.rows[0].id;
}

async function upsertGoogleDeviceTrait(
  client: pg.PoolClient,
  trait: GoogleTraitManifestEntry,
): Promise<number> {
  const res = await client.query<{ id: number }>(
    `INSERT INTO google_device_traits (name, value, valid_parameters) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (value) DO UPDATE SET value = EXCLUDED.value
     RETURNING id`,
    [
      fallbackName(trait.value),
      trait.value,
      trait.constraint ? JSON.stringify(trait.constraint) : null,
    ],
  );
  return res.rows[0].id;
}

async function seedManifest(client: pg.PoolClient, m: DeviceManifest) {
  // 1. Upsert the device type (catalog identity).
  const deviceRes = await client.query<{ id: number }>(
    `INSERT INTO devices (type, version, default_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (type, version) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [m.deviceType, m.version, `${m.deviceType} ${m.version}`],
  );
  const deviceId = deviceRes.rows[0].id;

  // 2. Upsert each capability declared by the firmware.
  for (const c of m.capabilities) {
    const googleTypeId = c.google_action_type
      ? await upsertGoogleActionType(client, c.google_action_type)
      : null;

    const capRes = await client.query<{ id: number }>(
      `INSERT INTO device_capabilities
         (device_id, capability_key, label, implementation_type, mqtt_action_type,
          mqtt_action_name, min_telemetry_interval_ms, google_type_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (device_id, capability_key) DO UPDATE SET
         label = EXCLUDED.label,
         implementation_type = EXCLUDED.implementation_type,
         mqtt_action_type = EXCLUDED.mqtt_action_type,
         mqtt_action_name = EXCLUDED.mqtt_action_name,
         min_telemetry_interval_ms = EXCLUDED.min_telemetry_interval_ms,
         google_type_id = EXCLUDED.google_type_id
       RETURNING id`,
      [
        deviceId,
        c.capability_key,
        c.label,
        c.implementation_type,
        c.mqtt_action_type,
        c.mqtt_action_name,
        c.min_telemetry_interval_ms ?? null,
        googleTypeId,
      ],
    );
    const capabilityId = capRes.rows[0].id;

    // 3. Append new pins only — existing rows are immutable (stable IDs relied on by FK).
    for (const p of c.configurable_pins ?? []) {
      await client.query(
        `INSERT INTO device_capability_pins (capability_id, key, label, mode)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (capability_id, key) DO NOTHING`,
        [capabilityId, p.key, p.label, p.mode],
      );
    }

    // 4. Append new trait links only — same immutability rationale.
    for (const trait of c.google_traits ?? []) {
      const traitId = await upsertGoogleDeviceTrait(client, trait);
      await client.query(
        `INSERT INTO device_capability_traits (capability_id, google_trait_id)
         VALUES ($1, $2)
         ON CONFLICT (capability_id, google_trait_id) DO NOTHING`,
        [capabilityId, traitId],
      );
    }

    // 5. Append new behavior rows only (command | interval | on_demand) — same immutability
    //    rationale as pins/traits: user_action_configurations FK these, and a firmware change
    //    ships as a new device version with its own fresh rows, so an existing row never changes.
    for (const cfg of c.configurations ?? []) {
      await client.query(
        `INSERT INTO capability_configurations (capability_id, behavior, min_interval_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (capability_id, behavior) DO NOTHING`,
        [capabilityId, cfg.behavior, cfg.min_interval_ms ?? null],
      );
    }
  }
  console.log(`🌱 catalog: ${m.deviceType} ${m.version} — ${m.capabilities.length} capabilities`);
}

async function main() {
  const manifests = loadManifests();
  const client = await pool.connect();
  try {
    for (const m of manifests) {
      // One transaction per device manifest: its capabilities + pins + traits land atomically.
      await client.query('BEGIN');
      await seedManifest(client, m);
      await client.query('COMMIT');
    }
    console.log(`✅ seeded ${manifests.length} device-type manifest(s)`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
