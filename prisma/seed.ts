import pg from 'pg';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: join(__dirname, '..', '.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Re-apply DB privileges that a `prisma migrate reset` (DROP/CREATE SCHEMA
// public) silently wipes. Roles are cluster-level so they survive the reset,
// but their grants do not — without this the EMQX postgres authenticator goes
// `disconnected` and every device/app MQTT login is refused as "Not authorized".
// Mirrors local-sql/010.init-app-user.sh; safe to run repeatedly.
async function reapplyGrants() {
  const backendUser = process.env.BACKEND_DB_USER;
  const emqxUser = process.env.EMQX_DB_USERNAME;

  if (!backendUser) throw new Error('BACKEND_DB_USER env var is required');
  if (!emqxUser) throw new Error('EMQX_DB_USERNAME env var is required');

  const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
  console.log(`🔑 Re-applying grants for ${backendUser} and ${emqxUser}`);

  const roleExists = async (role: string) =>
    (await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount! > 0;

  if (await roleExists(backendUser)) {
    const b = ident(backendUser);
    await pool.query(`
      GRANT USAGE, CREATE ON SCHEMA public TO ${b};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${b};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${b};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${b};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${b};
    `);
  } else {
    console.warn(`   ⚠️  role ${backendUser} not found — skipping backend grants`);
  }

  // EMQX postgres authenticator only needs to read mqtt_user — nothing else.
  if (await roleExists(emqxUser)) {
    const e = ident(emqxUser);
    await pool.query(`
      GRANT USAGE ON SCHEMA public TO ${e};
      GRANT SELECT ON mqtt_user TO ${e};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${e};
    `);
  } else {
    console.warn(`   ⚠️  role ${emqxUser} not found — skipping EMQX grants`);
  }
}

async function main() {
  await reapplyGrants();

  // Seed the mqtt-service's MQTT broker credentials into the EMQX auth table.
  // These are NOT the backend's PostgreSQL user — see BACKEND_DB_USER for that.
  const mqttUsername = process.env.MQTT_APP_USERNAME;
  const mqttPassword = process.env.MQTT_APP_PASSWORD;
  if (!mqttUsername) throw new Error('MQTT_APP_USERNAME env var is required');
  if (!mqttPassword) throw new Error('MQTT_APP_PASSWORD env var is required');

  console.log(`🌱 Seeding MQTT broker user: ${mqttUsername}`);
  await pool.query(
    `INSERT INTO mqtt_user (username, password_hash, is_superuser)
     VALUES ($1, $2, true)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_superuser = EXCLUDED.is_superuser`,
    [mqttUsername, await bcrypt.hash(mqttPassword, 10)],
  );

  // Pre-seed the owner as a Google-type admin placeholder (no password, no google_id yet).
  // On first Google login the OAuth flow links the google_id to this row automatically.
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    console.log(`🌱 Seeding owner placeholder: ${ownerEmail}`);
    await pool.query(
      `INSERT INTO users (email, user_role, user_type)
       VALUES ($1, 'admin', 1)
       ON CONFLICT (email) DO NOTHING`,
      [ownerEmail],
    );
  }

  // Credential admin — a username+password admin so the credentials-login flow (F2) works on a
  // fresh stack (the Google placeholder above has no password, so it can't credential-login).
  // This runs POST-migration (unlike local-sql/, which is pre-migration and can't touch app
  // tables). Credentials come ONLY from OWNER_USERNAME / OWNER_PASSWORD — there is no default, so
  // if either is unset no admin is created (never a default-credential backdoor). This is what the
  // device-sim and e2e tests log in as.
  const adminUser = process.env.OWNER_USERNAME;
  const adminPass = process.env.OWNER_PASSWORD;
  if (adminUser && adminPass) {
    console.log(`🌱 Seeding credential admin: ${adminUser}`);
    await pool.query(
      `INSERT INTO users (user_name, email, password, user_role, user_type, terms_accepted_at)
       VALUES ($1, $2, $3, 'admin', 0, now())
       ON CONFLICT (user_name) DO UPDATE SET password = EXCLUDED.password, user_role = 'admin'`,
      [adminUser, `${adminUser}@lattice.local`, await bcrypt.hash(adminPass, 10)],
    );
  } else {
    console.log('ℹ️  OWNER_USERNAME/OWNER_PASSWORD not set — skipping credential admin seed');
  }

  // Sync ML models from ml-executor/models.json — that file is the single source of truth.
  // On conflict (kind, name, version) the row is updated so config changes are picked up on re-seed.
  const modelsPath = join(__dirname, '..', 'services', 'ml-executor', 'models.json');
  const mlModels = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
    kind: string;
    name: string;
    version: string;
    backend: string;
    modelFile?: string;
    ollamaModel?: string;
    classes?: string[];
  }[];
  console.log(`🌱 Seeding ML models from models.json (${mlModels.length} entries)`);
  for (const m of mlModels) {
    await pool.query(
      `INSERT INTO ml_models (kind, name, version, backend, model_file, ollama_model, classes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (kind, name, version) DO UPDATE
         SET backend      = EXCLUDED.backend,
             model_file   = EXCLUDED.model_file,
             ollama_model = EXCLUDED.ollama_model,
             classes      = EXCLUDED.classes`,
      [
        m.kind,
        m.name,
        m.version,
        m.backend,
        m.modelFile ?? null,
        m.ollamaModel ?? null,
        m.classes ? JSON.stringify(m.classes) : null,
      ],
    );
    console.log(`   ✓ ${m.kind}/${m.name}/${m.version} (${m.backend})`);
  }

  // Prune rows left behind by a rename/removal in models.json (upsert above never deletes).
  // Skip any still referenced by a pipeline_stage instead of failing the whole seed run.
  const current = mlModels.map((m) => `${m.kind}|${m.name}|${m.version}`);
  const { rows: stale } = await pool.query<{
    id: number;
    kind: string;
    name: string;
    version: string;
  }>(
    `SELECT id, kind, name, version FROM ml_models
     WHERE (kind || '|' || name || '|' || version) <> ALL($1::text[])`,
    [current],
  );
  for (const s of stale) {
    try {
      await pool.query('DELETE FROM ml_models WHERE id = $1', [s.id]);
      console.log(`   🗑️  Pruned stale ml_model ${s.kind}/${s.name}/${s.version}`);
    } catch {
      console.log(
        `   ⚠️  Skipped pruning ${s.kind}/${s.name}/${s.version} — still referenced by a pipeline stage`,
      );
    }
  }

  console.log('✅ Seed completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
