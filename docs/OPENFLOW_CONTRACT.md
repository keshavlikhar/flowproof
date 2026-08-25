# Openflow contract simulation

FlowProof can test a documentation-derived contract when a Snowflake trial cannot run Openflow. This is useful engineering evidence, but it is not evidence that the Openflow product itself ran correctly.

## Documented workflow used by the simulator

Snowflake documents the PostgreSQL connector as a staged workflow:

1. `CaptureChangePostgreSQL` consumes PostgreSQL CDC, batches DML/DDL into FlowFiles, and advances its replication-slot position after a processed batch.
2. `EnrichCdcStream` tracks schemas and selects a versioned per-table journal.
3. `PublishChangeDataSnowpipeStreaming` writes incremental changes through Snowpipe Streaming.
4. `MergeSnowflakeJournalTable` asynchronously merges a journal into the destination table.
5. Destination rows contain `_SNOWFLAKE_INSERTED_AT`, `_SNOWFLAKE_UPDATED_AT`, and `_SNOWFLAKE_DELETED`; deletes are soft deletes.

Official sources:

- [PostgreSQL connector setup and snapshot workflow](https://docs.snowflake.com/en/user-guide/data-integration/openflow/connectors/postgres/setup)
- [Connector behavior, metadata, schema changes, and limitations](https://docs.snowflake.com/en/user-guide/data-integration/openflow/connectors/postgres/about)
- [`CaptureChangePostgreSQL`](https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/capturechangepostgresql)
- [`EnrichCdcStream`](https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/enrichcdcstream)
- [`PublishChangeDataSnowpipeStreaming`](https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/publishchangedatasnowpipestreaming)
- [`MergeSnowflakeJournalTable`](https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/mergesnowflakejournaltable)

## What FlowProof models

| Boundary | Simulator evidence |
| --- | --- |
| PostgreSQL committed transactions | Native `pgoutput` messages are buffered through the commit message. |
| Durable capture before acknowledgement | Journal events and an LSN-bearing ledger row commit before the slot is acknowledged. |
| Capture replay | A slot/xid/commit-LSN key makes a replay after lost acknowledgement a no-op. |
| Asynchronous application | `relay-merge` reads committed journal events later and updates the target in a separate transaction. |
| Merge retry | Target DML and the ledger's `merged_at` marker commit or roll back together. |
| Destination shape | Inserts, updates, soft deletes, and configured inserted/updated/deleted metadata are exercised. |
| Simulator reconciliation barrier | `relay-barrier` compares PostgreSQL's acknowledged LSN with numeric ledger LSNs and refuses reconciliation while any transaction through the boundary is unmerged. |
| Temporal precision | PostgreSQL date/time values remain exact text through pgoutput and retain all six supported microsecond digits. |

The simulation journal is deliberately named `FLOWPROOF_OPENFLOW_SIM_JOURNAL`. It is a generic transaction journal, not a copy of Openflow's internal per-table `<table>_JOURNAL_<epoch>_<schema_generation>` tables.

## What remains unverified

- The actual Snowflake Openflow runtime, deployment, queues, processor state, and upgrades
- Snowpipe Streaming channels and committed offset tokens
- Initial snapshots and concurrent snapshot/CDC orchestration
- DDL routing, schema generations, and journal rollover
- Openflow's TOAST unchanged-value placeholder handling
- Error routing, partial rows, and runtime-specific recovery behavior
- An observed mapping from an Openflow source commit LSN through its journal to final destination rows

Run `flowproof openflow-contract --config <path>` to generate the coverage matrix from the active configuration. Its overall conclusion is intentionally always `PARTIAL` until a separate real-Openflow pilot supplies runtime evidence.
