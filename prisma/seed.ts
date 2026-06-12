import pg from 'pg';
import bcrypt from 'bcryptjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // ── Google Action Types ────────────────────────────────────────────────────
  console.log('🌱 Seeding google_action_types...');
  await pool.query(`
    INSERT INTO google_action_types (key, name) VALUES
      ('action.devices.types.OUTLET',     'Outlet'),
      ('action.devices.types.LIGHT',      'Light'),
      ('action.devices.types.SWITCH',     'Switch'),
      ('action.devices.types.THERMOSTAT', 'Thermostat'),
      ('action.devices.types.FAN',        'Fan'),
      ('action.devices.types.BLINDS',     'Blinds'),
      ('action.devices.types.SENSOR',     'Sensor'),
      ('action.devices.types.CAMERA',     'Camera')
    ON CONFLICT (key) DO NOTHING
  `);

  // ── Google Traits ──────────────────────────────────────────────────────────
  console.log('🌱 Seeding google_traits...');
  await pool.query(`
    INSERT INTO google_traits (key, name, params) VALUES
      ('action.devices.traits.OnOff',              'On / Off',            '["on","off"]'),
      ('action.devices.traits.Brightness',         'Brightness',          '["brightness"]'),
      ('action.devices.traits.ColorSetting',       'Color Setting',       '["color"]'),
      ('action.devices.traits.OpenClose',          'Open / Close',        '["openPercent","openDirection"]'),
      ('action.devices.traits.TemperatureSetting', 'Temperature Setting', '["thermostatMode","thermostatTemperatureSetpoint"]'),
      ('action.devices.traits.FanSpeed',           'Fan Speed',           '["fanSpeed","fanSpeedRelativeWeight"]'),
      ('action.devices.traits.WaterLevel',         'Water Level',         '["waterLevelPercent"]'),
      ('action.devices.traits.PhLevel',            'pH Level',            '["phValue"]'),
      ('action.devices.traits.TdsLevel',           'TDS Level',           '["tdsPpm"]'),
      ('action.devices.traits.CO2Level',           'CO2 Level',           '["co2Ppm"]'),
      ('action.devices.traits.CameraStream',       'Camera Stream',       '[]')
    ON CONFLICT (key) DO NOTHING
  `);

  // ── MQTT app user ──────────────────────────────────────────────────────────
  const mqttUsername = process.env.MQTT_APP_USERNAME ?? 'ts_backend_app';
  const mqttPassword = process.env.MQTT_APP_PASSWORD ?? 'password123';
  console.log(`🌱 Seeding MQTT user: ${mqttUsername}`);
  await pool.query(
    `INSERT INTO mqtt_user (username, password_hash, is_superuser)
     VALUES ($1, $2, true)
     ON CONFLICT (username) DO NOTHING`,
    [mqttUsername, await bcrypt.hash(mqttPassword, 10)],
  );

  // ── Owner / admin user ─────────────────────────────────────────────────────
  const ownerEmail    = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  const ownerUsername = process.env.OWNER_USERNAME;
  if (ownerEmail && ownerPassword) {
    console.log(`🌱 Seeding owner user: ${ownerEmail}`);
    await pool.query(
      `INSERT INTO users (email, role, user_name, password, user_type)
       VALUES ($1, 'admin', $2, $3, 1)
       ON CONFLICT (email) DO NOTHING`,
      [ownerEmail, ownerUsername ?? null, await bcrypt.hash(ownerPassword, 10)],
    );
  }

  // ── ML Models ──────────────────────────────────────────────────────────────
  console.log('🌱 Seeding ml_models...');
  const mlModels = [
    {
      kind: 'llm',
      name: 'rule_generator',
      version: '1.0',
      description: 'Generic AI rule generator — converts a goal description into automation rules using available device capabilities',
      config: JSON.stringify({ endpoint: 'http://localhost:11434/api/generate', model_id: 'qwen2.5vl:7b' }),
    },
    {
      kind: 'llm',
      name: 'qwen2.5vl',
      version: '7b',
      description: 'Qwen2.5-VL 7B — reasoning model: receives YOLO detections + sensor context, returns decision',
      config: JSON.stringify({ endpoint: 'http://localhost:11434/api/generate', model_id: 'qwen2.5vl:7b' }),
    },
    {
      kind: 'vlm',
      name: 'visual-inspector',
      version: '1.0',
      description: 'YOLO-based visual inspection model for camera frames',
      config: JSON.stringify({ endpoint: 'http://localhost:11434/api/generate', model_id: 'yolo11n' }),
    },
  ];
  for (const m of mlModels) {
    await pool.query(
      `INSERT INTO ml_models (kind, name, version, description, config)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (kind, name, version) DO UPDATE SET
         config = EXCLUDED.config,
         description = EXCLUDED.description`,
      [m.kind, m.name, m.version, m.description, m.config],
    );
  }

  console.log('✅ Seed completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
