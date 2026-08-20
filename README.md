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

The first live collector retrieves column metadata, windowed counts, distinct-key counts, and freshness watermarks. It intentionally reports content correctness as `UNKNOWN` until a cross-database canonical checksum is implemented. Cost is also `UNKNOWN` unless configured; the optional serverless-task estimate remains low-confidence because it excludes storage, transfer, and other compute.

## Proof model

| Dimension | Evidence required | Pass condition |
| --- | --- | --- |
| Correct data | Counts and deterministic content checksums from the same closed window | Counts are within tolerance and checksums match |
| Exactly once | Stable key, source count, target count, target distinct-key count | No duplicate keys and no missing/extra keys |
| On time | Source and target high watermarks | Lag is within the configured SLA |
| Correct schema | Source and target column metadata | Source columns exist with compatible type and nullability |
| Controlled bill | Tagged compute, serverless, storage, and transfer run rate | Projection is below the configured monthly budget |

## What is intentionally missing

- Automatic selection of safe reconciliation windows
- Canonical cross-database checksum serialization
- Snowflake Openflow and Postgres mirror status collectors
- Contract-rate-aware cost attribution
- GitHub Checks or Slack delivery

Those should be built only after validating the evidence report and experimental collector with 3–5 Snowflake/PostgreSQL teams.

## Pilot success criteria

1. Find at least three teams that have experienced a silent missing/duplicate/late/schema incident or an ingestion cost surprise.
2. Run FlowProof beside an existing pipeline for two weeks without blocking it.
3. Demonstrate one actionable detection and fewer than 10% noisy alerts.
4. Confirm the buyer values a combined evidence report more than separate SQL monitors.
5. Only then add automatic collection and a CI/deployment gate.
