#!/bin/sh
# Runs once, when the database volume is first created. Never connect the API with the administrator
# login: it creates the two logins the API uses (docs/COMPANY-ISOLATION.md). NOT YET RUN: Docker has
# not been available on the development machine.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE ROLE geoattend_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$PG_OWNER_PASSWORD';
CREATE ROLE geoattend_tenant LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$PG_TENANT_PASSWORD';
ALTER DATABASE "$POSTGRES_DB" OWNER TO geoattend_owner;
ALTER SCHEMA public OWNER TO geoattend_owner;
SQL
