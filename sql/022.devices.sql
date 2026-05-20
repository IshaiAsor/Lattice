CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        type VARCHAR(255),
        version VARCHAR(255),
        default_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
