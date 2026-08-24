#!/bin/sh
set -eu

: "${FLOWPROOF_READER_PASSWORD:?FLOWPROOF_READER_PASSWORD is required}"
: "${OPENFLOW_CONNECTOR_PASSWORD:?OPENFLOW_CONNECTOR_PASSWORD is required}"

psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=flowproof_reader_password="$FLOWPROOF_READER_PASSWORD" \
  --set=openflow_connector_password="$OPENFLOW_CONNECTOR_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE flowproof_reader LOGIN PASSWORD %L', :'flowproof_reader_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowproof_reader') \gexec

SELECT format('CREATE ROLE openflow_connector LOGIN REPLICATION PASSWORD %L', :'openflow_connector_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openflow_connector') \gexec
SQL
