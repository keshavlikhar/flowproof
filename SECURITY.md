# Security policy

The FlowProof verifier is designed to operate with read-only database access and retain aggregated evidence rather than raw customer data.

The test-only WAL relay is a separate data-path component. It necessarily reads changed row values and writes them to Snowflake. Give it separate PostgreSQL replication and Snowflake writer identities, run only one instance per slot, and never reuse verifier credentials. Password authentication is supported for the local pilot; Snowflake key-pair authentication is supported and preferred for a deployed service.

Do not report security vulnerabilities in a public issue. Until a private security contact is configured on the repository host, contact the repository owner directly through a private channel.

Never include database credentials, connection strings, source rows, customer identifiers, or unredacted evidence snapshots in a report.

Supported security fixes currently target the latest `0.x` release only.
