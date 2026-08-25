# FlowProof

New to the repository? Start with the [architecture map](ARCHITECTURE.md), then follow the [free pilot tutorial](pilot/README.md). The [Openflow contract note](docs/OPENFLOW_CONTRACT.md) separates documentation-derived simulation from actual runtime validation.

FlowProof is a local-first evidence checker for PostgreSQL-to-Snowflake delivery. It answers a deliberately bounded question:

> For the configured tables and reconciliation window, do we have evidence that the expected rows arrived once, within the freshness SLA, with a compatible schema, and within budget?

It does not claim that a point-in-time query proves universal exactly-once behavior. A moving window, changed source fingerprint, missing checksum, key, usage record, or timestamp produces `UNKNOWN`, never a false pass.

## Why this exists

Snowflake contains much of the raw evidence: table metadata, mirrored data, task/connector state, and account usage. Native PostgreSQL data mirroring also provides transactional apply semantics. CoCo can generate and run queries or explain failures. Neither is, by itself, a durable cross-system evidence contract that combines source reconciliation, delivery semantics, freshness, schema, and cost into one release gate.

FlowProof is that thin control layer. The verifier remains outside the data path and needs only read access. The repository also includes a separately credentialed, explicitly test-only contract simulator for exercising the documented capture → journal → merge boundaries when Openflow is unavailable in a trial account.

## Prototype

Node.js 22.6 or later is required; Node.js 24 is used in CI. Install the locked dependencies before running the CLI. No source rows or credentials are uploaded by FlowProof.

```bash
nvm use
npm ci
npm run audit
npm run plan
npm test
npm run typecheck
```

The `plan` command emits read-only PostgreSQL and Snowflake queries to collect evidence. The `audit` command evaluates a normalized JSON snapshot:

```bash
node src/cli.ts audit \
  --config examples/flowproof.json \
  --snapshot examples/snapshot.json
```

Use `--json` for CI output or `--html evidence/report.html` for a readable local report. Exit codes are `0` for pass, `1` for fail, and `2` for unknown or invalid input.

## Free functional pilot

The [`pilot`](pilot/README.md) directory contains a local PostgreSQL 17 environment and a tightly limited Snowflake trial setup. It lets you exercise the live cross-database checks without attaching a payment method. Snowflake trial accounts do not include Openflow, so this validates FlowProof functionality but is explicitly not a real CDC proof.

## Live verification (experimental)

The `verify` command connects directly to PostgreSQL and Snowflake with the official Node.js drivers, collects aggregate evidence, and evaluates it without writing to either database. Use dedicated read-only credentials and start with a small non-production table.

Copy `.env.example` to a Git-ignored `.env`, restrict its permissions, and replace the placeholders. FlowProof never writes credentials to a snapshot.

```bash
cp .env.example .env
chmod 600 .env
```

An explicit closed time window is required to prevent an accidental whole-table scan and to avoid testing data that is still expected to arrive:

```bash
node --env-file=.env src/cli.ts verify \
  --config examples/flowproof.json \
  --since 2026-08-18T10:00:00Z \
  --until 2026-08-18T10:15:00Z
```

Add `--save-snapshot evidence/orders.json` to retain the aggregate evidence locally with owner-only file permissions. FlowProof creates the directory but refuses to overwrite an existing snapshot. The `evidence/` directory is ignored by Git.

Before the first live run, validate connectivity, UTC sessions, table permissions, and the optional capture/cost setup:

```bash
node --env-file=.env src/cli.ts doctor \
  --config evidence/flowproof.local.json
```

The live collector retrieves:

- Active-row counts that can exclude Openflow rows marked `_SNOWFLAKE_DELETED = TRUE`
- Distinct-key counts plus deterministic key and content checksums in adaptive buckets
- Minimum, p95, and maximum destination apply lag, plus timestamp coverage
- Source metadata before and after target collection to reject a window that changed mid-scan
- Numeric precision/scale, text length, timestamp semantics/precision, and safe nullability
- PostgreSQL logical replication-slot state, LSN progress, and retained-WAL risk
- Named cost components with their source, data latency, coverage, and missing components

Checksums are computed inside each database from a canonical representation; raw rows are not uploaded to FlowProof. Bucket width grows for large windows, and `reconciliation.maxRowsPerTable` prevents an unexpected checksum scan. If a configured type cannot be normalized safely, checksum evidence is omitted and the result is `UNKNOWN`.

Version 2 also requires a settled window. It compares the requested end time with both database clocks and the configured delay, then fingerprints the source again after target collection:

```json
{
  "reconciliation": {
    "settleDelaySeconds": 120,
    "maxRowsPerTable": 1000000,
    "sourceStabilityCheck": true
  }
}
```

The Openflow-specific table settings look like this:

```json
{
  "freshnessColumn": "updated_at",
  "checksumColumns": ["id", "status", "updated_at"],
  "targetSoftDeleteColumn": "_SNOWFLAKE_DELETED",
  "targetApplyTimestampColumn": "_SNOWFLAKE_UPDATED_AT"
}
```

Configure the replication slot name shown in the Openflow `CaptureChangePostgreSQL` processor state:

```json
{
  "replication": {
    "postgresSlotName": "snowflake_connector_example",
    "maxUnconfirmedWalBytes": 104857600,
    "maxRetainedWalBytes": 1073741824
  }
}
```

For a rolling local check, use `watch`. Each run chooses a host-time window behind the settle delay; the collector still independently rejects it if either database clock says it is unsafe:

```bash
node --env-file=.env src/cli.ts watch \
  --config evidence/flowproof.local.json \
  --window-minutes 60 \
  --interval-seconds 300 \
  --html evidence/latest.html
```

Use `--once` to test the rolling-window calculation without leaving a process running.

## Test-only Openflow contract simulator

The [`pilot`](pilot/README.md) tutorial includes a native PostgreSQL `pgoutput` relay. It models selected behavior described in Snowflake's Openflow documentation; it does not reproduce, execute, or validate the Openflow runtime.

For each PostgreSQL transaction, the relay:

1. Buffers row changes until the PostgreSQL commit message.
2. Starts one Snowflake transaction.
3. Checks a ledger key made from the slot, source transaction ID, and commit LSN.
4. Appends changes to a simulation journal and writes the ledger record atomically.
5. Only after that durable commit acknowledges the commit LSN to PostgreSQL.
6. A separate `relay-merge` operation later applies inserts, updates, and soft deletes and marks the ledger row merged in one transaction.
7. PostgreSQL temporal values stay as exact text at the WAL boundary, avoiding JavaScript's millisecond-only `Date` precision.

If the process loses its connection after journal commit but before acknowledgement, PostgreSQL sends the transaction again. The ledger makes the second capture a no-op, after which the relay safely acknowledges it. A failed destination merge remains pending and can be retried. The relay must run as one instance per slot; Snowflake primary-key declarations are informational and do not provide concurrency control.

After a merge, evaluate the exact commit LSN printed by `relay-run`:

```bash
node --env-file=.env src/cli.ts relay-barrier \
  --config evidence/flowproof.local.json \
  --lsn 0/019742A0
```

A passing barrier proves that PostgreSQL acknowledged through that commit, the exact commit exists in the durable ledger, and no transaction through it remains unmerged. Run a settled broad-window reconciliation after the barrier to include old rows and soft deletes. This is evidence for the test relay only; a production Openflow gate needs equivalent runtime evidence from Openflow processor/journal state.

Inspect the honest coverage matrix at any time:

```bash
node src/cli.ts openflow-contract --config pilot/flowproof.example.json
```

The matrix is always `PARTIAL`: WAL capture, durable simulation-journal staging, asynchronous merge, mapped DML, metadata, soft deletes, and deterministic failures are modeled. Snowpipe Streaming offsets, Openflow FlowFiles/queues, snapshots, schema generations, TOAST behavior, and the actual Openflow runtime remain unverified.

## Proof model

| Dimension | Evidence required | Pass condition |
| --- | --- | --- |
| Correct data | Counts and deterministic content checksums from the same closed window | Counts are within tolerance and checksums match |
| Delivery integrity | Stable key, distinct-key counts, and bucketed key-set checksums | No duplicate keys and the active source/target key sets match |
| On time | Copied source update timestamp and destination apply timestamp | Every active row has a non-negative apply lag and the maximum is within SLA |
| Correct schema | Source and target column metadata | Types, timestamp semantics, precision/capacity, and nullability are safe |
| Source capture | PostgreSQL logical-slot state and LSN byte differences | Slot is active, valid, and within configured WAL limits |
| Controlled bill | Attributed warehouse, serverless, storage, and transfer run rate | Every expected component is present and projection is below budget |

Cost reporting is staged. Set a contracted rate and the expected inventory explicitly. A partial inventory can show measured dollars, but it remains `UNKNOWN`:

```text
FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD=3.00
FLOWPROOF_COST_EXPECTED_COMPONENTS=warehouse,serverless-task,storage,transfer
FLOWPROOF_SNOWFLAKE_TASK_NAME=APPLY_MIRROR_ORDERS
FLOWPROOF_SNOWFLAKE_STORAGE_MONTHLY_USD=12.50
FLOWPROOF_SNOWFLAKE_TRANSFER_MONTHLY_USD=0
```

Snowflake `ACCOUNT_USAGE` data can lag, and its database role must be granted separately. FlowProof displays the evidence source rather than hiding that uncertainty.

## What remains intentionally unproven

- A runtime-observed Openflow source-commit-LSN to final Snowflake-row mapping
- Actual Openflow queue and journal-to-destination merge progress collectors
- A production Openflow source-LSN-to-merge barrier (the native simulator now has its own ledger barrier)
- GitHub Checks or Slack delivery
- Concurrent relay instances and arbitrary PostgreSQL types/schema evolution in the test relay

The free pilot proves FlowProof's evaluator and tests its documentation-derived contract model. Only an actual Openflow design-partner environment can validate the Openflow-specific behavior.

## Pilot success criteria

1. Find at least three teams that have experienced a silent missing/duplicate/late/schema incident or an ingestion cost surprise.
2. Run FlowProof beside an existing pipeline for two weeks without blocking it.
3. Demonstrate one actionable detection and fewer than 10% noisy alerts.
4. Confirm the buyer values a combined evidence report more than separate SQL monitors.
5. Only then add automatic collection and a CI/deployment gate.
