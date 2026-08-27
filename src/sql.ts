import type { Config, TableMapping } from "./types.ts";
import { targetFreshness, targetPrimaryKeys } from "./mapping.ts";

function splitTable(name: string): [string, string] {
  const parts = name.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
    throw new Error(`Table must be schema.table using simple identifiers: ${name}`);
  }
  return [parts[0], parts[1]];
}

function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

function stringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function postgresFor(mapping: TableMapping): string[] {
  const [schema, table] = splitTable(mapping.source);
  const keyColumns = mapping.primaryKey.map(identifier);
  const distinctKeys = keyColumns.length === 1 ? keyColumns[0] : `(${keyColumns.join(", ")})`;
  const freshnessColumn = identifier(mapping.freshnessColumn);
  return [
    `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, character_maximum_length, datetime_precision FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position;`,
    `SELECT COUNT(*) AS row_count, MAX(${freshnessColumn}) AS max_freshness FROM ${schema}.${table} WHERE ${freshnessColumn} >= '<SINCE_ISO>'::timestamptz AND ${freshnessColumn} < '<UNTIL_ISO>'::timestamptz;`,
    keyColumns.length ? `SELECT COUNT(DISTINCT ${distinctKeys}) AS distinct_primary_keys FROM ${schema}.${table} WHERE ${freshnessColumn} >= '<SINCE_ISO>'::timestamptz AND ${freshnessColumn} < '<UNTIL_ISO>'::timestamptz;` : "-- No primary key configured.",
    `-- The live collector also calculates adaptive deterministic key/content checksum buckets for this closed window.`,
  ];
}

function snowflakeFor(mapping: TableMapping): string[] {
  const [schema, table] = splitTable(mapping.target);
  const keys = targetPrimaryKeys(mapping).map(identifier);
  const freshnessColumn = identifier(targetFreshness(mapping));
  const softDelete = mapping.targetSoftDeleteColumn ? identifier(mapping.targetSoftDeleteColumn) : undefined;
  const applyTimestamp = mapping.targetApplyTimestampColumn ? identifier(mapping.targetApplyTimestampColumn) : undefined;
  const activePredicate = softDelete ? ` AND COALESCE(${softDelete}, FALSE) = FALSE` : "";
  const deliveryLag = applyTimestamp
    ? `, MIN(DATEDIFF('second', ${freshnessColumn}, ${applyTimestamp})) AS min_delivery_lag_seconds, APPROX_PERCENTILE(DATEDIFF('second', ${freshnessColumn}, ${applyTimestamp}), 0.95) AS p95_delivery_lag_seconds, MAX(DATEDIFF('second', ${freshnessColumn}, ${applyTimestamp})) AS max_delivery_lag_seconds, COUNT_IF(${applyTimestamp} IS NOT NULL) AS delivery_lag_row_count, COUNT_IF(${applyTimestamp} IS NULL) AS missing_delivery_timestamp_count`
    : "";
  return [
    `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, character_maximum_length, datetime_precision FROM INFORMATION_SCHEMA.COLUMNS WHERE table_schema = '${schema.toUpperCase()}' AND table_name = '${table.toUpperCase()}' ORDER BY ordinal_position;`,
    `SELECT COUNT(*) AS row_count, MAX(${freshnessColumn}) AS max_freshness${deliveryLag} FROM ${schema}.${table} WHERE ${freshnessColumn} >= TO_TIMESTAMP_TZ('<SINCE_ISO>') AND ${freshnessColumn} < TO_TIMESTAMP_TZ('<UNTIL_ISO>')${activePredicate};`,
    keys.length ? `SELECT COUNT(DISTINCT ${keys.join(", ")}) AS distinct_primary_keys FROM ${schema}.${table} WHERE ${freshnessColumn} >= TO_TIMESTAMP_TZ('<SINCE_ISO>') AND ${freshnessColumn} < TO_TIMESTAMP_TZ('<UNTIL_ISO>')${activePredicate};` : "-- No primary key configured.",
    `-- The live collector applies the same active-row filter and declared deterministic transformations to key/content checksum buckets.`,
    `-- Cost evidence (ACCOUNT_USAGE can lag): query warehouse, serverless task, storage, and transfer usage for this pipeline's tagged resources.`,
  ];
}

export function queryPlan(config: Config): string {
  const sections: string[] = [];
  if (config.replication) {
    sections.push(`-- PostgreSQL logical replication-slot evidence
SELECT slot_name, active, restart_lsn, confirmed_flush_lsn, pg_current_wal_lsn() AS current_wal_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS unconfirmed_wal_bytes,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_wal_bytes,
       wal_status
FROM pg_replication_slots
WHERE slot_name = ${stringLiteral(config.replication.postgresSlotName)} AND slot_type = 'logical';`);
  }
  for (const mapping of config.tables) {
    sections.push(`-- PostgreSQL evidence for ${mapping.source}\n${postgresFor(mapping).join("\n")}`);
    sections.push(`-- Snowflake evidence for ${mapping.target}\n${snowflakeFor(mapping).join("\n")}`);
  }
  return sections.join("\n\n");
}
