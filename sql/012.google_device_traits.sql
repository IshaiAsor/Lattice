CREATE TABLE IF NOT EXISTS google_device_traits (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            value VARCHAR(255) NOT NULL,
            valid_parameters JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM google_device_traits LIMIT 1) THEN
        INSERT INTO google_device_traits (name, value, valid_parameters) VALUES
            ('On / Off', 'action.devices.traits.OnOff', '["on","off"]'),
            ('Brightness', 'action.devices.traits.Brightness', '["brightness"]'),
            ('Color Setting', 'action.devices.traits.ColorSetting', '["color"]'),
            ('Open / Close', 'action.devices.traits.OpenClose', '["openPercent", "openDirection"]'),
            ('Temperature Setting', 'action.devices.traits.TemperatureSetting', '["thermostatMode", "thermostatTemperatureSetpoint", "thermostatTemperatureSetpointHigh", "thermostatTemperatureSetpointLow"]'),
            ('Fan Speed', 'action.devices.traits.FanSpeed', '["fanSpeed", "fanSpeedRelativeWeight", "fanSpeedRelativePercentage"]');
END IF;
END $$;
