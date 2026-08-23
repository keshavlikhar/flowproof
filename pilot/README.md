# Free FlowProof Pilot

This pilot validates FlowProof's cross-database schema, active-row count, key-set checksum, content checksum, and delivery-lag checks without attaching a payment method.

It does **not** prove PostgreSQL-to-Snowflake CDC. Snowflake trial accounts currently do not include Openflow, so the Snowflake target rows deliberately simulate the documented Openflow destination shape.

## 1. Start PostgreSQL locally

Start Docker Desktop, then create a private local environment file:

```bash
cp pilot/postgres/pilot.env.example pilot/postgres/pilot.env
```

Replace the three passwords in `pilot.env`, then run:

```bash
docker compose \
  --env-file pilot/postgres/pilot.env \
  -f pilot/postgres/docker-compose.yml \
  up -d
```

PostgreSQL listens only on `127.0.0.1:5433`. It contains `public.orders`, a read-only `flowproof_reader`, an Openflow-ready publication, and logical WAL settings.

## 2. Create the Snowflake trial target

Create a Snowflake trial without adding a payment method. Select Standard Edition. In Snowsight, open a SQL worksheet and run `pilot/snowflake/setup_trial.sql` after replacing its user password placeholder.

The script uses an X-Small warehouse, 60-second auto-suspend, a one-credit monthly resource monitor, and explicitly suspends the warehouse when setup finishes.

After setup, run `pilot/snowflake/validate_trial.sql` in a new worksheet. Its final result should be `PASS`. The preceding result tabs let you inspect the warehouse safety controls, resource monitor, read-only grants, and target-table schema. The validation script explicitly suspends the warehouse when it finishes.

The simulated Openflow metadata timestamps are stored as UTC `TIMESTAMP_NTZ` values. Validation converts the source `TIMESTAMP_TZ` value to a UTC wall-clock timestamp before calculating lag, so the account's session timezone cannot distort the result.

## 3. Configure FlowProof

Copy the safe configuration template:

```bash
cp pilot/flowproof.example.json evidence/flowproof.local.json
```

Update the ignored root `.env` with the local PostgreSQL reader password and the Snowflake trial values. Use:

```text
FLOWPROOF_POSTGRES_URL=postgresql://flowproof_reader:<reader-password>@127.0.0.1:5433/flowproof_pilot
FLOWPROOF_SNOWFLAKE_WAREHOUSE=FLOWPROOF_PILOT_WH
FLOWPROOF_SNOWFLAKE_DATABASE=FLOWPROOF_PILOT
FLOWPROOF_SNOWFLAKE_SCHEMA=RAW
FLOWPROOF_SNOWFLAKE_ROLE=FLOWPROOF_READER
```

The ignored `evidence/flowproof.local.json` is now configured for these tables.

## 4. Run the functional proof

```bash
node --env-file=.env src/cli.ts verify \
  --config evidence/flowproof.local.json \
  --since 2026-08-22T17:00:00Z \
  --until 2026-08-22T19:00:00Z \
  --save-snapshot evidence/first-pilot.json
```

Schema, correctness, key reconciliation, and timeliness should pass. Cost remains `UNKNOWN` because the current cost collector does not yet attribute this warehouse safely. The overall result is therefore expected to be `UNKNOWN`, not `PASS`.

## Stop the pilot

Suspend the Snowflake warehouse:

```sql
ALTER WAREHOUSE FLOWPROOF_PILOT_WH SUSPEND;
```

Stop local PostgreSQL without deleting its data:

```bash
docker compose \
  --env-file pilot/postgres/pilot.env \
  -f pilot/postgres/docker-compose.yml \
  down
```
