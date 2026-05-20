create table if not exists device_actions (
        id SERIAL PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        default_name VARCHAR(255) NOT NULL,
        google_type_id INTEGER NOT NULL,
        mqtt_action_type VARCHAR(255),
        mqtt_action_name VARCHAR(255)
);
