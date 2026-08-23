# Free FlowProof Pilot

This pilot validates FlowProof's cross-database schema, active-row count, key-set checksum, content checksum, safe-window, and delivery-lag checks without attaching a payment method.

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

PostgreSQL `TIMESTAMPTZ` is represented as Snowflake `TIMESTAMP_LTZ`, matching Openflow's documented mapping. Simulated Openflow metadata timestamps use UTC `TIMESTAMP_NTZ`. FlowProof forces both sessions to UTC and refuses negative lag instead of silently changing it to zero.

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

Schema, correctness, delivery integrity, and timeliness should pass. Capture health and cost remain visible as optional `UNKNOWN` results. Under the `pilot` policy, the overall result is therefore `PASS`; a `production` policy would remain `UNKNOWN` until those dimensions are proven.

Create a readable report at the same time:

```bash
node --env-file=.env src/cli.ts audit \
  --config evidence/flowproof.local.json \
  --snapshot evidence/first-pilot.json \
  --html evidence/first-pilot.html
```

Check setup problems without collecting table evidence:

```bash
node --env-file=.env src/cli.ts doctor \
  --config evidence/flowproof.local.json
```

## 5. Optional Openflow contract simulation

This section is explicitly **not an Openflow test**. It models the documented capture → durable journal → asynchronous merge workflow so we can test PostgreSQL transaction boundaries, replay deduplication, acknowledgements, and both failure boundaries without claiming the real runtime was exercised.

First display the exact coverage and gaps:

```bash
node src/cli.ts openflow-contract \
  --config evidence/flowproof.local.json
```

### Human step: create the Snowflake writer

In a Snowsight worksheet, open `pilot/snowflake/setup_relay.sql`, replace its password placeholder with a new password that is different from the reader password, and run the whole file. This is the only required browser step.

Add the relay credentials to the ignored root `.env`:

```text
FLOWPROOF_RELAY_POSTGRES_URL=postgresql://openflow_connector:<connector-password>@127.0.0.1:5433/flowproof_pilot
FLOWPROOF_RELAY_SNOWFLAKE_ACCOUNT=<same account identifier>
FLOWPROOF_RELAY_SNOWFLAKE_USER=FLOWPROOF_RELAY
FLOWPROOF_RELAY_SNOWFLAKE_PASSWORD=<new relay password>
FLOWPROOF_RELAY_SNOWFLAKE_WAREHOUSE=FLOWPROOF_PILOT_WH
FLOWPROOF_RELAY_SNOWFLAKE_DATABASE=FLOWPROOF_PILOT
FLOWPROOF_RELAY_SNOWFLAKE_SCHEMA=RAW
FLOWPROOF_RELAY_SNOWFLAKE_ROLE=FLOWPROOF_RELAY_ROLE
```

For a deployed service, use `FLOWPROOF_RELAY_SNOWFLAKE_PRIVATE_KEY_PATH` and its optional passphrase variable instead of a password.

Create the native `pgoutput` slot and verify the Snowflake simulation journal and ledger. The relay role cannot create arbitrary Snowflake tables; the browser setup script owns that step:

```bash
node --env-file=.env src/cli.ts relay-setup \
  --config evidence/flowproof.local.json
```

Start capture in terminal A. Three source transactions will be durably journaled and acknowledged, then it stops:

```bash
node --env-file=.env src/cli.ts relay-run \
  --config evidence/flowproof.local.json \
  --max-transactions 3
```

In terminal B, send one insert, one update, and one delete through PostgreSQL WAL:

```bash
docker compose \
  --env-file pilot/postgres/pilot.env \
  -f pilot/postgres/docker-compose.yml \
  exec -T postgres psql -U flowproof_admin -d flowproof_pilot \
  < pilot/postgres/exercise_relay.sql
```

The relay should print three journaled source transaction IDs and LSNs. At this point the destination must still be unchanged. Apply the pending journal transactions separately:

```bash
node --env-file=.env src/cli.ts relay-merge \
  --config evidence/flowproof.local.json \
  --max-transactions 3
```

Now the destination insert/update/soft-delete changes should be visible, and each ledger row should have `merged_at` populated.

### Prove replay after a capture-side network-shaped failure

Start a one-transaction relay that deliberately fails after the Snowflake commit but before PostgreSQL acknowledgement:

```bash
FLOWPROOF_RELAY_FAILURE_POINT=after-snowflake-commit \
node --env-file=.env src/cli.ts relay-run \
  --config evidence/flowproof.local.json \
  --max-transactions 1
```

While it is listening, commit one new change in PostgreSQL. The command should fail intentionally. Restart it without the failure variable:

```bash
node --env-file=.env src/cli.ts relay-run \
  --config evidence/flowproof.local.json \
  --max-transactions 1
```

It should print `Relay skipped`: PostgreSQL replayed the unacknowledged transaction, the Snowflake ledger proved the journal already committed, no event was journaled twice, and the relay then acknowledged the LSN.

`before-snowflake-commit` is the other supported failure point. That scenario rolls back Snowflake, does not acknowledge PostgreSQL, and applies normally after restart.

### Prove merge retry

With a pending journal transaction, fail immediately before the destination transaction commits:

```bash
FLOWPROOF_RELAY_MERGE_FAILURE_POINT=before-merge-commit \
node --env-file=.env src/cli.ts relay-merge \
  --config evidence/flowproof.local.json \
  --max-transactions 1
```

The target write and `merged_at` update roll back together. Run the same command without the failure variable; it should merge once. `after-merge-commit` models losing the client response after commit: the next run finds no pending ledger row and does not reapply it.

## 6. Optional staged cost evidence

`pilot/snowflake/enable_cost_reading.sql` grants Snowflake's `USAGE_VIEWER` database role to the verifier. That exposes account-level usage history, so review the scope and skip it if the correctness pilot does not need cost. Then configure the contracted credit rate, expected components, and explicit storage/transfer allocations shown in the root README. Incomplete or delayed usage stays `UNKNOWN`.

What this still cannot prove:

- Openflow read or applied the same WAL transaction.
- Openflow's own durable state maps a source commit-LSN to a destination row.
- Openflow journal/merge queues and SPCS runtime stayed healthy.
- Snowpipe Streaming committed-offset behavior, snapshot orchestration, schema generations, and TOAST handling match the documentation in the deployed version.
- Deletes are fully reconciled by a freshness window; a transaction/LSN barrier is still needed for that stronger proof.

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
