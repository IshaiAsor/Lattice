import pg from 'pg';
import bcrypt from 'bcryptjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Google Action Types
  console.log('🌱 Seeding google_action_types...');
  await pool.query(`
    INSERT INTO google_action_types (name, value) VALUES
      ('Outlet',     'action.devices.types.OUTLET'),
      ('Light',      'action.devices.types.LIGHT'),
      ('Switch',     'action.devices.types.SWITCH'),
      ('Thermostat', 'action.devices.types.THERMOSTAT'),
      ('Fan',        'action.devices.types.FAN'),
      ('Blinds',     'action.devices.types.BLINDS'),
      ('Sensor',     'action.devices.types.SENSOR')
    ON CONFLICT (value) DO NOTHING
  `);

  // Google Device Traits
  console.log('🌱 Seeding google_device_traits...');
  await pool.query(`
    INSERT INTO google_device_traits (name, value, valid_parameters) VALUES
      ('On / Off',             'action.devices.traits.OnOff',              '["on","off"]'),
      ('Brightness',           'action.devices.traits.Brightness',         '["brightness"]'),
      ('Color Setting',        'action.devices.traits.ColorSetting',       '["color"]'),
      ('Open / Close',         'action.devices.traits.OpenClose',          '["openPercent", "openDirection"]'),
      ('Temperature Setting',  'action.devices.traits.TemperatureSetting', '["thermostatMode", "thermostatTemperatureSetpoint", "thermostatTemperatureSetpointHigh", "thermostatTemperatureSetpointLow"]'),
      ('Fan Speed',            'action.devices.traits.FanSpeed',           '["fanSpeed", "fanSpeedRelativeWeight", "fanSpeedRelativePercentage"]'),
      ('Water Level',          'action.devices.traits.WaterLevel',         '["waterLevelPercent"]'),
      ('pH Level',             'action.devices.traits.PhLevel',            '["phValue"]'),
      ('TDS Level',            'action.devices.traits.TdsLevel',           '["tdsPpm"]'),
      ('CO2 Level',            'action.devices.traits.CO2Level',           '["co2Ppm"]')
    ON CONFLICT (value) DO NOTHING
  `);

  // Devices
  console.log('🌱 Seeding devices...');
  await pool.query(`
    INSERT INTO devices (type, version, default_name, created_at, updated_at)
    VALUES ('ESP32_SmartOutlet', 'V1.0.0', 'ESP32_SmartOutlet', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (default_name) DO NOTHING
  `);

  // Device Actions
  console.log('🌱 Seeding device_actions...');
  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'outlet1', t.id, 'command', 'outlet1',
      'OutletAction',
      '{"values":["on","off","0","1"]}'::jsonb,
      '[{"pinNumber":4,"pinMode":"OUTPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.OUTLET'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'OutletAction',
      valid_parameters    = '{"values":["on","off","0","1"]}'::jsonb,
      pins                = '[{"pinNumber":4,"pinMode":"OUTPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'Tempture Sensor 1', t.id, 'telemetry', 'sensor1',
      'TemperatureAction',
      '{"values":[]}'::jsonb,
      '[{"pinNumber":7,"pinMode":"INPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'TemperatureAction',
      valid_parameters    = '{"values":[]}'::jsonb,
      pins                = '[{"pinNumber":7,"pinMode":"INPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'fan1', t.id, 'command', 'fan1',
      'OneDirectionalMotorAction',
      '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      '[{"pinNumber":5,"pinMode":"OUTPUT"},{"pinNumber":18,"pinMode":"OUTPUT"},{"pinNumber":19,"pinMode":"OUTPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.FAN'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'OneDirectionalMotorAction',
      valid_parameters    = '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      pins                = '[{"pinNumber":5,"pinMode":"OUTPUT"},{"pinNumber":18,"pinMode":"OUTPUT"},{"pinNumber":19,"pinMode":"OUTPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'dimmer1', t.id, 'command', 'dimmer1',
      'LightDimmerAction',
      '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      '[{"pinNumber":17,"pinMode":"OUTPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.LIGHT'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'LightDimmerAction',
      valid_parameters    = '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      pins                = '[{"pinNumber":17,"pinMode":"OUTPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'Water Level Sensor 1', t.id, 'telemetry', 'water_level',
      'WaterLevelAction',
      '{"values":[]}'::jsonb,
      '[{"pinNumber":6,"pinMode":"INPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'WaterLevelAction',
      valid_parameters    = '{"values":[]}'::jsonb,
      pins                = '[{"pinNumber":6,"pinMode":"INPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'pH Sensor 1', t.id, 'telemetry', 'ph_level', 'PhLevelAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":8,"pinMode":"INPUT"}]'::jsonb, 5000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'PhLevelAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":8,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 5000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'TDS Sensor 1', t.id, 'telemetry', 'tds_level', 'TdsLevelAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":9,"pinMode":"INPUT"}]'::jsonb, 5000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'TdsLevelAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":9,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 5000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'Humidity Sensor 1', t.id, 'telemetry', 'humidity', 'HumidityAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, 2000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'HumidityAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 2000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'Air Temperature Sensor 1', t.id, 'telemetry', 'air_temp', 'AirTemperatureAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, 2000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'AirTemperatureAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 2000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'CO2 Sensor 1', t.id, 'telemetry', 'co2_level', 'CO2LevelAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":11,"pinMode":"INPUT"},{"pinNumber":12,"pinMode":"OUTPUT"}]'::jsonb, 5000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32_SmartOutlet' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'CO2LevelAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":11,"pinMode":"INPUT"},{"pinNumber":12,"pinMode":"OUTPUT"}]'::jsonb, telemetry_interval_ms = 5000
  `);

  // Action Type Traits
  console.log('🌱 Seeding action_type_traits...');
  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da, google_device_traits gt
    WHERE da.default_name = 'outlet1' AND gt.value = 'action.devices.traits.OnOff'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da, google_device_traits gt
    WHERE da.default_name = 'fan1' AND gt.value = 'action.devices.traits.OnOff'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da, google_device_traits gt
    WHERE da.default_name = 'fan1' AND gt.value = 'action.devices.traits.FanSpeed'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da, google_device_traits gt
    WHERE da.default_name = 'Tempture Sensor 1' AND gt.value = 'action.devices.traits.TemperatureSetting'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32_SmartOutlet' AND da.default_name = 'Water Level Sensor 1'
      AND gt.value = 'action.devices.traits.WaterLevel'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32_SmartOutlet' AND da.default_name = 'pH Sensor 1'
      AND gt.value = 'action.devices.traits.PhLevel'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32_SmartOutlet' AND da.default_name = 'TDS Sensor 1'
      AND gt.value = 'action.devices.traits.TdsLevel'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32_SmartOutlet' AND da.default_name = 'Humidity Sensor 1'
      AND gt.value = 'action.devices.traits.HumiditySetting'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32_SmartOutlet' AND da.default_name = 'Air Temperature Sensor 1'
      AND gt.value = 'action.devices.traits.TemperatureSetting'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32_SmartOutlet' AND da.default_name = 'CO2 Sensor 1'
      AND gt.value = 'action.devices.traits.CO2Level'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da, google_device_traits gt
    WHERE da.default_name = 'dimmer1' AND gt.value = 'action.devices.traits.OnOff'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da, google_device_traits gt
    WHERE da.default_name = 'dimmer1' AND gt.value = 'action.devices.traits.Brightness'
    ON CONFLICT DO NOTHING
  `);

  // Google Camera action type
  console.log('🌱 Seeding Camera google action type...');
  await pool.query(`
    INSERT INTO google_action_types (name, value) VALUES ('Camera', 'action.devices.types.CAMERA')
    ON CONFLICT (value) DO NOTHING
  `);

  // ESP32S3_Mini device (same action set as ESP32_SmartOutlet)
  console.log('🌱 Seeding ESP32S3_Mini device...');
  await pool.query(`
    INSERT INTO devices (type, version, default_name, created_at, updated_at)
    VALUES ('ESP32S3_Mini', 'V1.0.0', 'ESP32S3_Mini', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (default_name) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'outlet1', t.id, 'command', 'outlet1', 'OutletAction',
      '{"values":["on","off","0","1"]}'::jsonb,
      '[{"pinNumber":4,"pinMode":"OUTPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.OUTLET'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'OutletAction',
      valid_parameters    = '{"values":["on","off","0","1"]}'::jsonb,
      pins                = '[{"pinNumber":4,"pinMode":"OUTPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'Temperature Sensor 1', t.id, 'telemetry', 'sensor1', 'TemperatureAction',
      '{"values":[]}'::jsonb,
      '[{"pinNumber":7,"pinMode":"INPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'TemperatureAction',
      valid_parameters    = '{"values":[]}'::jsonb,
      pins                = '[{"pinNumber":7,"pinMode":"INPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'fan1', t.id, 'command', 'fan1', 'OneDirectionalMotorAction',
      '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      '[{"pinNumber":5,"pinMode":"OUTPUT"},{"pinNumber":18,"pinMode":"OUTPUT"},{"pinNumber":19,"pinMode":"OUTPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.FAN'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'OneDirectionalMotorAction',
      valid_parameters    = '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      pins                = '[{"pinNumber":5,"pinMode":"OUTPUT"},{"pinNumber":18,"pinMode":"OUTPUT"},{"pinNumber":19,"pinMode":"OUTPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'dimmer1', t.id, 'command', 'dimmer1', 'LightDimmerAction',
      '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      '[{"pinNumber":17,"pinMode":"OUTPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.LIGHT'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'LightDimmerAction',
      valid_parameters    = '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
      pins                = '[{"pinNumber":17,"pinMode":"OUTPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins)
    SELECT d.id, 'Water Level Sensor 1', t.id, 'telemetry', 'water_level', 'WaterLevelAction',
      '{"values":[]}'::jsonb,
      '[{"pinNumber":6,"pinMode":"INPUT"}]'::jsonb
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type = 'WaterLevelAction',
      valid_parameters    = '{"values":[]}'::jsonb,
      pins                = '[{"pinNumber":6,"pinMode":"INPUT"}]'::jsonb
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'pH Sensor 1', t.id, 'telemetry', 'ph_level', 'PhLevelAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":8,"pinMode":"INPUT"}]'::jsonb, 5000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'PhLevelAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":8,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 5000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'TDS Sensor 1', t.id, 'telemetry', 'tds_level', 'TdsLevelAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":9,"pinMode":"INPUT"}]'::jsonb, 5000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'TdsLevelAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":9,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 5000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'Humidity Sensor 1', t.id, 'telemetry', 'humidity', 'HumidityAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, 2000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'HumidityAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 2000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'Air Temperature Sensor 1', t.id, 'telemetry', 'air_temp', 'AirTemperatureAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, 2000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'AirTemperatureAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":21,"pinMode":"INPUT"},{"pinNumber":22,"pinMode":"INPUT"}]'::jsonb, telemetry_interval_ms = 2000
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'CO2 Sensor 1', t.id, 'telemetry', 'co2_level', 'CO2LevelAction',
      '{"values":[]}'::jsonb, '[{"pinNumber":11,"pinMode":"INPUT"},{"pinNumber":12,"pinMode":"OUTPUT"}]'::jsonb, 5000
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Mini' AND t.value = 'action.devices.types.SENSOR'
    ON CONFLICT (device_id, default_name) DO UPDATE SET implementation_type = 'CO2LevelAction',
      valid_parameters = '{"values":[]}'::jsonb, pins = '[{"pinNumber":11,"pinMode":"INPUT"},{"pinNumber":12,"pinMode":"OUTPUT"}]'::jsonb, telemetry_interval_ms = 5000
  `);

  // ESP32S3_Mini action type traits (scoped by device JOIN to avoid name collision)
  console.log('🌱 Seeding ESP32S3_Mini action type traits...');
  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'outlet1'
      AND gt.value = 'action.devices.traits.OnOff'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'fan1'
      AND gt.value = 'action.devices.traits.OnOff'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'fan1'
      AND gt.value = 'action.devices.traits.FanSpeed'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'Temperature Sensor 1'
      AND gt.value = 'action.devices.traits.TemperatureSetting'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'dimmer1'
      AND gt.value = 'action.devices.traits.OnOff'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'dimmer1'
      AND gt.value = 'action.devices.traits.Brightness'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'Water Level Sensor 1'
      AND gt.value = 'action.devices.traits.WaterLevel'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'pH Sensor 1'
      AND gt.value = 'action.devices.traits.PhLevel'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'TDS Sensor 1'
      AND gt.value = 'action.devices.traits.TdsLevel'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'Humidity Sensor 1'
      AND gt.value = 'action.devices.traits.HumiditySetting'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'Air Temperature Sensor 1'
      AND gt.value = 'action.devices.traits.TemperatureSetting'
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Mini' AND da.default_name = 'CO2 Sensor 1'
      AND gt.value = 'action.devices.traits.CO2Level'
    ON CONFLICT DO NOTHING
  `);

  // CameraStream trait
  console.log('🌱 Seeding CameraStream trait...');
  await pool.query(`
    INSERT INTO google_device_traits (name, value, valid_parameters) VALUES
      ('Camera Stream', 'action.devices.traits.CameraStream', '[]')
    ON CONFLICT (value) DO NOTHING
  `);

  // ESP32S3_Cam device
  console.log('🌱 Seeding ESP32S3_Cam device...');
  await pool.query(`
    INSERT INTO devices (type, version, default_name, created_at, updated_at)
    VALUES ('ESP32S3_Cam', 'V1.0.0', 'ESP32S3_Cam', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (default_name) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO device_actions (device_id, default_name, google_type_id, mqtt_action_type, mqtt_action_name, implementation_type, valid_parameters, pins, telemetry_interval_ms)
    SELECT d.id, 'Camera 1', t.id, 'telemetry', 'camera', 'LiveStreamAction',
      '{"values":[]}'::jsonb,
      '[]'::jsonb,
      333
    FROM devices d, google_action_types t
    WHERE d.default_name = 'ESP32S3_Cam' AND t.value = 'action.devices.types.CAMERA'
    ON CONFLICT (device_id, default_name) DO UPDATE SET
      implementation_type   = 'LiveStreamAction',
      valid_parameters      = '{"values":[]}'::jsonb,
      pins                  = '[]'::jsonb,
      telemetry_interval_ms = 500
  `);

  // ESP32S3_Cam action type traits
  console.log('🌱 Seeding ESP32S3_Cam action type traits...');
  await pool.query(`
    INSERT INTO action_type_traits (device_action_type_id, google_trait_id)
    SELECT da.id, gt.id FROM device_actions da
    JOIN devices d ON d.id = da.device_id, google_device_traits gt
    WHERE d.default_name = 'ESP32S3_Cam' AND da.default_name = 'Camera 1'
      AND gt.value = 'action.devices.traits.CameraStream'
    ON CONFLICT DO NOTHING
  `);

  // MQTT app user
  const mqttUsername = process.env.MQTT_APP_USERNAME || 'ts_backend_app';
  const mqttPassword = process.env.MQTT_APP_PASSWORD || 'password123';
  console.log(`🌱 Seeding MQTT user: ${mqttUsername}`);
  await pool.query(
    `INSERT INTO mqtt_user (username, password_hash, is_superuser)
     VALUES ($1, $2, true)
     ON CONFLICT (username) DO NOTHING`,
    [mqttUsername, await bcrypt.hash(mqttPassword, 10)]
  );

  // Owner user
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  const ownerUsername = process.env.OWNER_USERNAME;
  if (ownerEmail && ownerPassword) {
    console.log(`🌱 Seeding owner user: ${ownerEmail}`);
    await pool.query(
      `INSERT INTO users (email, user_role, user_name, password, user_type)
       VALUES ($1, 'admin', $2, $3, 1)
       ON CONFLICT (email) DO NOTHING`,
      [ownerEmail, ownerUsername ?? null, await bcrypt.hash(ownerPassword, 10)]
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
