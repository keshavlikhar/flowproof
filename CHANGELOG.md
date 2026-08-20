# Changelog

This project follows Semantic Versioning. While the project is below `1.0.0`, minor releases may contain interface changes.

## Unreleased

- Added experimental read-only PostgreSQL and Snowflake live collectors.
- Added bounded-window `verify` command and optional aggregate snapshot saving.
- Changed low-confidence cost estimates to `UNKNOWN` rather than `PASS`.

## 0.1.0 — 2026-08-19

- Added deterministic schema, correctness, exactly-once, timeliness, and cost checks.
- Added terminal and JSON reports with explicit `UNKNOWN` semantics.
- Added safe PostgreSQL and Snowflake evidence-query generation.
- Added examples, automated tests, and continuous integration.
