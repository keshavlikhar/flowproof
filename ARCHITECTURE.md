# FlowProof architecture

This is the shortest useful map of the codebase.

## Verifier path

```text
flowproof.json
      │
      ▼
 validate.ts ── rejects unsafe or incomplete configuration
      │
      ▼
 collect.ts ─── queries PostgreSQL and Snowflake for aggregate evidence
      │
      ▼
 snapshot.json ─ local evidence record; no credentials or source rows
      │
      ▼
 audit.ts ───── deterministic PASS / FAIL / UNKNOWN rules
      │
      ├── render.ts ─ terminal report
      ├── html.ts ─── self-contained HTML report
      └── JSON ─────── CI output
```

`src/cli.ts` wires those pieces into `audit`, `plan`, `doctor`, `verify`, and `watch`. `src/clients.ts` is the only verifier module that owns database-driver connections. `src/checksum.ts` builds matching canonical checksum SQL for both databases, compiles the allow-listed transformation contract, and classifies bounded fingerprint differences. `src/policy.ts` decides which dimensions block the overall result.

The verifier does not decide by AI. Every result comes from deterministic evidence and a visible rule.

## Transformation and mismatch rule

Raw equality remains the default. A table can opt into a deterministic contract consisting only of column renames, text case/whitespace normalization, and explicit source-to-target value maps. The config validator rejects arbitrary expressions and ambiguous duplicate mappings. Source value maps are compiled into a fixed SQL `CASE`; normalization is applied on both databases before canonical framing and hashing.

On a checksum failure, `collect.ts` inspects only mismatched buckets whose observed row counts are below the configured bound. It queries hashed primary-key and content fingerprints, never raw values. A bucket is classified only when both complete bounded result sets still match their earlier bucket counts; otherwise it is marked skipped because the evidence changed or was too large.

## Safe-window rule

A version 2 verification can pass content, key, or timing checks only when:

1. The requested end time is older than the configured settle delay according to both database clocks.
2. PostgreSQL returns the same schema, count, key count, freshness watermark, and checksum buckets before and after Snowflake collection.
3. Both sides used the exact half-open window `[since, until)`.

If any condition is absent or ambiguous, those dimensions become `UNKNOWN`.

## Test-only Openflow contract path

```text
PostgreSQL WAL / pgoutput
      │ committed transaction
      ▼
 relay.ts buffers its row changes
      │
      ▼
 Snowflake transaction
      ├── APPEND simulation-journal events
      └── INSERT unmerged transaction-ledger record
      │ commit succeeds
      ▼
 acknowledge commit LSN to PostgreSQL
      │
      ▼
 relay-merge (asynchronous)
      │ Snowflake transaction
      ├── MERGE target rows / mark deletes
      └── mark ledger transaction merged
```

The ledger key is `slot + source transaction ID + commit LSN`. A crash after journal commit but before PostgreSQL acknowledgement causes a replay. On replay, the ledger record is found, duplicate journal writes are skipped, and the LSN is acknowledged. Destination merging is independently retryable.

This shape is derived from Snowflake's published capture, enrichment, Snowpipe Streaming, and journal-merge documentation. It tests boundaries under FlowProof's control, not Openflow internals. The generic simulation journal is intentionally different from Openflow's per-table, schema-generation journals.

The relay is deliberately narrow and test-only:

- One process per replication slot
- Simple `schema.table` and same-name source/target columns
- Insert, update, and delete; truncate is rejected
- Openflow-shaped soft deletes when configured
- No initial snapshot/bootstrap, FlowFiles, Snowpipe Streaming offsets, DDL/schema-generation handling, TOAST emulation, arbitrary type conversion, or Openflow claim

## Trust boundaries

- Verifier credentials are read-only and never reused by the relay.
- Relay credentials can read PostgreSQL changes and write only the pilot Snowflake objects.
- `.env`, local configurations, evidence snapshots, and HTML reports are ignored by Git.
- Database values stay in the process. Aggregate verifier evidence is written only when explicitly requested.

## Where to change behavior

| Goal | File |
| --- | --- |
| Add or change a proof rule | `src/audit.ts` |
| Change evidence queries | `src/collect.ts` |
| Support another canonical checksum type | `src/checksum.ts` |
| Add a policy profile | `src/policy.ts` |
| Add a CLI command | `src/cli.ts` |
| Change WAL apply/retry behavior | `src/relay.ts` |
| Change documented Openflow coverage labels | `src/openflow-contract.ts` |
| Change config or snapshot shape | `src/types.ts` and `src/validate.ts` |

Every behavioral change should add a passing, failing, and missing/ambiguous-evidence test where applicable.
