import type { ChecksumBucket, Column, TableMapping } from "./types.ts";

type Engine = "postgres" | "snowflake";
type CanonicalFamily = "integer" | "decimal" | "text" | "boolean" | "date" | "timestamp";

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function family(type: string): CanonicalFamily | undefined {
  const normalized = type.toLowerCase().replace(/\(.*/, "").trim();
  if (["smallint", "integer", "bigint", "int", "int2", "int4", "int8"].includes(normalized)) return "integer";
  if (["numeric", "decimal", "number"].includes(normalized)) return "decimal";
  if (["text", "varchar", "character varying", "char", "character", "string", "uuid"].includes(normalized)) return "text";
  if (["boolean", "bool"].includes(normalized)) return "boolean";
  if (normalized === "date") return "date";
  if (normalized.startsWith("timestamp")) return "timestamp";
  return undefined;
}

function selectedColumns(mapping: TableMapping, sourceColumns: Column[]): Column[] {
  const byName = new Map(sourceColumns.map((column) => [column.name.toLowerCase(), column]));
  const requested = mapping.checksumColumns?.length ? mapping.checksumColumns : sourceColumns.map((column) => column.name);
  return requested.map((name) => {
    identifier(name);
    const column = byName.get(name.toLowerCase());
    if (!column) throw new Error(`Checksum column ${name} is missing from ${mapping.source}`);
    if (!family(column.type)) throw new Error(`Checksum column ${name} has unsupported type ${column.type}`);
    return column;
  });
}

function postgresValue(column: Column): string {
  const name = identifier(column.name);
  const kind = family(column.type);
  if (kind === "integer") return `${name}::numeric::text`;
  if (kind === "decimal") return `regexp_replace(regexp_replace(${name}::numeric::text, '(\\.[0-9]*?)0+$', '\\1'), '\\.$', '')`;
  if (kind === "text") return `${name}::text`;
  if (kind === "boolean") return `CASE WHEN ${name} THEN 'true' ELSE 'false' END`;
  if (kind === "date") return `to_char(${name}, 'YYYY-MM-DD')`;
  if (kind === "timestamp") {
    const normalizedType = column.type.toLowerCase();
    const utc = normalizedType.includes("with time zone") || normalizedType === "timestamptz" ? `${name} AT TIME ZONE 'UTC'` : name;
    return `to_char(${utc}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  }
  throw new Error(`Checksum column ${name} has unsupported type ${column.type}`);
}

function snowflakeValue(column: Column): string {
  const name = identifier(column.name);
  const kind = family(column.type);
  if (kind === "integer") return `TO_VARCHAR(${name})`;
  if (kind === "decimal") return `REGEXP_REPLACE(REGEXP_REPLACE(TO_VARCHAR(${name}), '(\\\\.[0-9]*?)0+$', '\\\\1'), '\\\\.$', '')`;
  if (kind === "text") return `TO_VARCHAR(${name})`;
  if (kind === "boolean") return `CASE WHEN ${name} THEN 'true' ELSE 'false' END`;
  if (kind === "date") return `TO_CHAR(${name}, 'YYYY-MM-DD')`;
  if (kind === "timestamp") return `TO_CHAR(CONVERT_TIMEZONE('UTC', ${name}), 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"')`;
  throw new Error(`Checksum column ${name} has unsupported type ${column.type}`);
}

function framed(engine: Engine, column: Column): string {
  const name = identifier(column.name);
  const value = engine === "postgres" ? postgresValue(column) : snowflakeValue(column);
  const length = engine === "postgres" ? `octet_length(convert_to(${value}, 'UTF8'))::text` : `TO_VARCHAR(OCTET_LENGTH(${value}))`;
  const concat = engine === "postgres" ? `(${length} || ':' || ${value})` : `CONCAT(${length}, ':', ${value})`;
  return `CASE WHEN ${name} IS NULL THEN '-1:' ELSE ${concat} END`;
}

function serialization(engine: Engine, columns: Column[]): string {
  if (!columns.length) throw new Error("At least one checksum column is required");
  return `CONCAT_WS('|', ${columns.map((column) => framed(engine, column)).join(", ")})`;
}

export function checksumQuery(
  engine: Engine,
  mapping: TableMapping,
  sourceColumns: Column[],
  qualifiedTable: string,
  predicate: string,
): string {
  if (!mapping.primaryKey.length) throw new Error(`A primary key is required to checksum ${mapping.source}`);
  const byName = new Map(sourceColumns.map((column) => [column.name.toLowerCase(), column]));
  const keyColumns = mapping.primaryKey.map((name) => {
    identifier(name);
    const column = byName.get(name.toLowerCase());
    if (!column) throw new Error(`Primary-key column ${name} is missing from ${mapping.source}`);
    if (!family(column.type)) throw new Error(`Primary-key column ${name} has unsupported type ${column.type}`);
    return column;
  });
  const contentColumns = selectedColumns(mapping, sourceColumns);
  const keyText = serialization(engine, keyColumns);
  const contentText = serialization(engine, contentColumns);
  const countCast = engine === "postgres" ? "COUNT(*)::text" : "COUNT(*)";
  const keyAggregate = engine === "postgres"
    ? "MD5(STRING_AGG(key_hash, '' ORDER BY key_text, content_hash))"
    : "MD5(LISTAGG(key_hash, '') WITHIN GROUP (ORDER BY key_text, content_hash))";
  const contentAggregate = engine === "postgres"
    ? "MD5(STRING_AGG(content_hash, '' ORDER BY key_text, content_hash))"
    : "MD5(LISTAGG(content_hash, '') WITHIN GROUP (ORDER BY key_text, content_hash))";
  return `WITH canonical AS (
  SELECT ${keyText} AS key_text, ${contentText} AS content_text
  FROM ${qualifiedTable}
  WHERE ${predicate}
), hashed AS (
  SELECT key_text, MD5(key_text) AS key_hash, MD5(content_text) AS content_hash,
         SUBSTR(MD5(key_text), 1, 2) AS bucket_id
  FROM canonical
)
SELECT bucket_id, ${countCast} AS row_count,
       ${keyAggregate} AS key_checksum,
       ${contentAggregate} AS content_checksum
FROM hashed
GROUP BY bucket_id
ORDER BY bucket_id`;
}

function field(row: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? row[key] : undefined;
}

export function parseChecksumBuckets(rows: Record<string, unknown>[]): ChecksumBucket[] {
  return rows.map((row) => {
    const rowCount = Number(field(row, "row_count"));
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("Checksum bucket row count is invalid");
    return {
      id: String(field(row, "bucket_id")),
      rowCount,
      keyChecksum: String(field(row, "key_checksum")),
      contentChecksum: String(field(row, "content_checksum")),
    };
  });
}
