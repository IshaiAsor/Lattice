CREATE TABLE IF NOT EXISTS google_action_types (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM google_action_types LIMIT 1) THEN
        INSERT INTO google_action_types (name, value) VALUES
                                                    ('Outlet', 'action.devices.types.OUTLET'),
                                                    ('Light', 'action.devices.types.LIGHT'),
                                                    ('Switch', 'action.devices.types.SWITCH'),
                                                    ('Thermostat', 'action.devices.types.THERMOSTAT'),
                                                    ('Fan', 'action.devices.types.FAN'),
                                                    ('Blinds', 'action.devices.types.BLINDS'),
                                                    ('Sensor', 'action.devices.types.SENSOR');
    END IF;
END $$;