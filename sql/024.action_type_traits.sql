create table if not exists action_type_traits (
        id SERIAL PRIMARY KEY ,
        device_action_type_id INTEGER NOT NULL REFERENCES device_actions(id) ON DELETE CASCADE,
        google_trait_id INTEGER NOT NULL REFERENCES google_device_traits(id) ON DELETE CASCADE
);