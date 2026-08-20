import type { Config, TableMapping } from "./types.ts";

function splitTable(name: string): [string, string] {
  const parts = name.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
    throw new Error(`Table must be schema.table using simple identifiers: ${name}`);
  }
  return [parts[0], parts[1]];
}

function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function postgresFor(mapping: TableMapping): string[] {
  const [schema, table] = splitTable(mapping.source);
  const keyColumns = mapping.primaryKey.map(identifier);
  const distinctKeys = keyColumns.length === 1 ? keyColumns[0] : `(${keyColumns.join(", ")})`;
  const freshnessColumn = identifier(mapping.freshnessColumn);
  return [
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position;`,
    `SELECT COUNT(*) AS row_count, MAX(${freshnessColumn}) AS max_freshness FROM "${schema}"."${table}";`,
    keyColumns.length ? `SELECT COUNT(DISTINCT ${distinctKeys}) AS distinct_primary_keys FROM "${schema}"."${table}";` : "-- No primary key configured.",
    `-- Add a bounded-window checksum using your database's canonical serialization for business columns.`,
  ];
}

function snowflakeFor(mapping: TableMapping): string[] {
  const [schema, table] = splitTable(mapping.target);
  const keys = mapping.primaryKey.map(identifier);
  const freshnessColumn = identifier(mapping.freshnessColumn);
  return [
    `SELECT column_name, data_type, is_nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE table_schema = '${schema.toUpperCase()}' AND table_name = '${table.toUpperCase()}' ORDER BY ordinal_position;`,
    `SELECT COUNT(*) AS row_count, MAX(${freshnessColumn}) AS max_freshness FROM "${schema}"."${table}";`,
    keys.length ? `SELECT COUNT(DISTINCT ${keys.join(", ")}) AS distinct_primary_keys FROM "${schema}"."${table}";` : "-- No primary key configured.",
    `-- Cost evidence (ACCOUNT_USAGE can lag): query warehouse, serverless task, storage, and transfer usage for this pipeline's tagged resources.`,
  ];
}

export function queryPlan(config: Config): string {
  const sections: string[] = [];
  for (const mapping of config.tables) {
    sections.push(`-- PostgreSQL evidence for ${mapping.source}\n${postgresFor(mapping).join("\n")}`);
    sections.push(`-- Snowflake evidence for ${mapping.target}\n${snowflakeFor(mapping).join("\n")}`);
  }
  return sections.join("\n\n");
}
