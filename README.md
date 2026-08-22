# FlowProof

FlowProof is a local-first evidence checker for PostgreSQL-to-Snowflake data delivery. It answers a deliberately bounded question:

> For the configured tables and reconciliation window, do we have evidence that the expected rows arrived once, within the freshness SLA, with a compatible schema, and within budget?

It does not claim that a point-in-time query proves universal exactly-once behavior. A missing checksum, key, usage record, or timestamp produces `UNKNOWN`, never a false pass.

## Why this exists

Snowflake contains much of the raw evidence: table metadata, mirrored data, task/connector state, and account usage. Native PostgreSQL data mirroring also provides transactional apply semantics. CoCo can generate and run queries or explain failures. Neither is, by itself, a durable cross-system evidence contract that combines source reconciliation, delivery semantics, freshness, schema, and cost into one release gate.

FlowProof is that thin control layer. It remains outside the data path and initially needs only read access.

## Prototype

Node.js 22.6 or later is required; Node.js 24 is used in CI. Install the locked dependencies before running the CLI. No source rows or credentials are uploaded by FlowProof.

```bash
nvm use
npm ci
npm run audit
npm run plan
npm test
```

The `plan` command emits read-only PostgreSQL and Snowflake queries to collect evidence. The `audit` command evaluates a normalized JSON snapshot:

```bash
node src/cli.ts audit \
  --config examples/flowproof.json \
  --snapshot examples/snapshot.json
```

Use `--json` for CI output. Exit codes are `0` for pass, `1` for fail, and `2` for unknown or invalid input.

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

The live collector now retrieves:

- Active-row counts that can exclude Openflow rows marked `_SNOWFLAKE_DELETED = TRUE`
- Distinct-key counts plus deterministic key and content checksums in 256 small buckets
- Openflow destination apply timestamps for measured source-update-to-target-apply lag
- PostgreSQL logical replication-slot state, LSN progress, and retained-WAL risk

Checksums are computed inside each database from a canonical representation; raw rows are not uploaded to FlowProof. If a configured column type cannot be normalized safely, checksum evidence is omitted and the result is `UNKNOWN`. The optional serverless-task cost estimate remains low-confidence because it excludes storage, transfer, and other compute.

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

## Proof model

| Dimension | Evidence required | Pass condition |
| --- | --- | --- |
| Correct data | Counts and deterministic content checksums from the same closed window | Counts are within tolerance and checksums match |
| Exactly once | Stable key, distinct-key counts, and bucketed key-set checksums | No duplicate keys and the active source/target key sets match |
| On time | Copied source update timestamp and Openflow target apply timestamp | Maximum observed apply lag is within the configured SLA |
| Correct schema | Source and target column metadata | Source columns exist with compatible type and nullability |
| Source capture | PostgreSQL logical-slot state and LSN byte differences | Slot is active, valid, and within configured WAL limits |
| Controlled bill | Tagged compute, serverless, storage, and transfer run rate | Projection is below the configured monthly budget |

## What is intentionally missing

- Automatic selection of safe reconciliation windows
- A documented Openflow source-commit-LSN to final Snowflake-row mapping
- Openflow queue and journal-to-destination merge progress collectors
- A write-assisted barrier mode for strongest end-to-end latency proof
- Contract-rate-aware cost attribution
- GitHub Checks or Slack delivery

Those should be built only after validating the evidence report and experimental collector with 3–5 Snowflake/PostgreSQL teams.

## Pilot success criteria

1. Find at least three teams that have experienced a silent missing/duplicate/late/schema incident or an ingestion cost surprise.
2. Run FlowProof beside an existing pipeline for two weeks without blocking it.
3. Demonstrate one actionable detection and fewer than 10% noisy alerts.
4. Confirm the buyer values a combined evidence report more than separate SQL monitors.
5. Only then add automatic collection and a CI/deployment gate.
