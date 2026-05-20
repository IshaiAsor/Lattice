#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname "$DB_NAME" <<-EOSQL
-- Enable the pgcrypto extension for bcrypt hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create the user table
CREATE TABLE IF NOT EXISTS mqtt_user (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    is_superuser BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


INSERT INTO mqtt_user (username, password_hash, is_superuser)
VALUES (
    '${MQTT_APP_USERNAME}', 
    crypt('${MQTT_APP_PASSWORD}', gen_salt('bf')), -- Generates a secure bcrypt hash
    true
)
ON CONFLICT (username) DO NOTHING;

CREATE USER ${EMQX_DB_USERNAME} WITH PASSWORD '${EMQX_DB_PASSWORD}';
GRANT SELECT ON mqtt_user TO ${EMQX_DB_USERNAME};
EOSQL
