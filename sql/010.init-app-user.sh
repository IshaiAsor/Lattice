#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname "$DB_NAME" <<-EOSQL
    CREATE USER ${BACKEND_DB_USER} WITH PASSWORD '${BACKEND_DB_PASSWORD}';
EOSQL
