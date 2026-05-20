create table if not exists device_action_types (
        id SERIAL PRIMARY KEY,
        description VARCHAR(255) NOT NULL,
        google_type_id INTEGER NOT NULL REFERENCES google_action_types(id) ON DELETE CASCADE    
);


