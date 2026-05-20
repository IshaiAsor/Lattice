 CREATE TABLE IF NOT EXISTS user_device_actions (
        id SERIAL PRIMARY KEY,
        user_device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
        action_id INTEGER NOT NULL REFERENCES device_actions(id) ON DELETE CASCADE,
        action_name VARCHAR(255) NOT NULL,
        current_state VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );