# Changelog

This project follows Semantic Versioning. While the project is below `1.0.0`, minor releases may contain interface changes.

## Unreleased

- Added a free local PostgreSQL 17 pilot with logical replication settings, seeded data, and least-privilege users.
- Added a Snowflake trial setup with X-Small compute, 60-second auto-suspend, and a one-credit resource monitor.
- Documented that Snowflake trial accounts cannot run Openflow and that the free pilot simulates its target-table shape.
- Added experimental read-only PostgreSQL and Snowflake live collectors.
- Added bounded-window `verify` command and optional aggregate snapshot saving.
- Added deterministic 256-bucket key and content checksums for closed reconciliation windows.
- Added Openflow soft-delete filtering and target apply-lag evidence.
- Added PostgreSQL logical replication-slot progress and retained-WAL risk checks.
- Changed exactly-once evaluation to require matching key-set checksums instead of trusting equal counts.
- Changed low-confidence cost estimates to `UNKNOWN` rather than `PASS`.

## 0.1.0 — 2026-08-19

- Added deterministic schema, correctness, exactly-once, timeliness, and cost checks.
- Added terminal and JSON reports with explicit `UNKNOWN` semantics.
- Added safe PostgreSQL and Snowflake evidence-query generation.
- Added examples, automated tests, and continuous integration.
