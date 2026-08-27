import type {
  ChecksumBucket,
  Column,
  ColumnComparison,
  ReconciliationDetails,
  RowDifference,
  TableMapping,
} from "./types.ts";
import { targetPrimaryKeys } from "./mapping.ts";

type Engine = "postgres" | "snowflake";
type CanonicalFamily = "integer" | "decimal" | "text" | "boolean" | "date" | "timestamp";

interface ResolvedColumn {
  column: Column;
  comparison?: ColumnComparison;
}

export interface FingerprintRow {
  bucketId: string;
  keyHash: string;
  contentHash: string;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function stringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function columnByName(columns: Column[], name: string, label: string): Column {
  identifier(name);
  const column = columns.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!column) throw new Error(`${label} column ${name} is missing`);
  if (!family(column.type)) throw new Error(`${label} column ${name} has unsupported type ${column.type}`);
  return column;
}

function configuredComparisons(mapping: TableMapping, sourceColumns: Column[]): ColumnComparison[] {
  if (mapping.columnComparisons?.length) return mapping.columnComparisons;
  const names = mapping.checksumColumns?.length ? mapping.checksumColumns : sourceColumns.map((column) => column.name);
  return names.map((source) => ({ source }));
}

function selectedColumns(engine: Engine, mapping: TableMapping, sourceColumns: Column[], actualColumns: Column[]): ResolvedColumn[] {
  return configuredComparisons(mapping, sourceColumns).map((comparison) => {
    const name = engine === "postgres" ? comparison.source : comparison.target ?? comparison.source;
    const column = columnByName(actualColumns, name, engine === "postgres" ? mapping.source : mapping.target);
    if ((comparison.normalize || comparison.valueMap) && family(column.type) !== "text") {
      throw new Error(`Transformation for ${comparison.source} requires a text column, observed ${column.type}`);
    }
    return { column, comparison };
  });
}

function keyColumns(engine: Engine, mapping: TableMapping, actualColumns: Column[]): ResolvedColumn[] {
  const names = engine === "snowflake" ? targetPrimaryKeys(mapping) : mapping.primaryKey;
  return names.map((name) => ({ column: columnByName(actualColumns, name, `${engine === "postgres" ? mapping.source : mapping.target} primary-key`) }));
}

function postgresValue(column: Column): string {
  const name = identifier(column.name);
  const kind = family(column.type);
  if (kind === "integer") return `${name}::numeric::text`;
  if (kind === "decimal") return `regexp_replace(regexp_replace(${name}::numeric::text, '(\\.[0-9]*[1-9])0+$', '\\1'), '\\.0+$', '')`;
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
  if (kind === "decimal") return `REGEXP_REPLACE(REGEXP_REPLACE(TO_VARCHAR(${name}), '(\\\\.[0-9]*[1-9])0+$', '\\\\1'), '\\\\.0+$', '')`;
  if (kind === "text") return `TO_VARCHAR(${name})`;
  if (kind === "boolean") return `CASE WHEN ${name} THEN 'true' ELSE 'false' END`;
  if (kind === "date") return `TO_CHAR(${name}, 'YYYY-MM-DD')`;
  if (kind === "timestamp") return `TO_CHAR(CONVERT_TIMEZONE('UTC', ${name}), 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"')`;
  throw new Error(`Checksum column ${name} has unsupported type ${column.type}`);
}

function transformedValue(engine: Engine, resolved: ResolvedColumn): string {
  const { column, comparison } = resolved;
  let value = engine === "postgres" ? postgresValue(column) : snowflakeValue(column);
  if (engine === "postgres" && comparison?.valueMap) {
    const branches = Object.entries(comparison.valueMap).map(([source, target]) => `WHEN ${stringLiteral(source)} THEN ${stringLiteral(target)}`).join(" ");
    value = `CASE ${value} ${branches} ELSE ${value} END`;
  }
  const normalize = comparison?.normalize;
  if (normalize === "trim") value = engine === "postgres" ? `BTRIM(${value})` : `TRIM(${value})`;
  if (normalize === "lowercase") value = `LOWER(${value})`;
  if (normalize === "uppercase") value = `UPPER(${value})`;
  if (normalize === "lowercase-trim") value = engine === "postgres" ? `LOWER(BTRIM(${value}))` : `LOWER(TRIM(${value}))`;
  if (normalize === "uppercase-trim") value = engine === "postgres" ? `UPPER(BTRIM(${value}))` : `UPPER(TRIM(${value}))`;
  return value;
}

function framed(engine: Engine, resolved: ResolvedColumn): string {
  const name = identifier(resolved.column.name);
  const value = transformedValue(engine, resolved);
  const length = engine === "postgres" ? `octet_length(convert_to(${value}, 'UTF8'))::text` : `TO_VARCHAR(OCTET_LENGTH(${value}))`;
  const concat = engine === "postgres" ? `(${length} || ':' || ${value})` : `CONCAT(${length}, ':', ${value})`;
  return `CASE WHEN ${name} IS NULL THEN '-1:' ELSE ${concat} END`;
}

function serialization(engine: Engine, columns: ResolvedColumn[]): string {
  if (!columns.length) throw new Error("At least one checksum column is required");
  return `CONCAT_WS('|', ${columns.map((column) => framed(engine, column)).join(", ")})`;
}

function canonicalCte(
  engine: Engine,
  mapping: TableMapping,
  sourceColumns: Column[],
  actualColumns: Column[],
  qualifiedTable: string,
  predicate: string,
): string {
  if (!mapping.primaryKey.length) throw new Error(`A primary key is required to checksum ${mapping.source}`);
  const keyText = serialization(engine, keyColumns(engine, mapping, actualColumns));
  const contentText = serialization(engine, selectedColumns(engine, mapping, sourceColumns, actualColumns));
  return `WITH canonical AS (
  SELECT ${keyText} AS key_text, ${contentText} AS content_text
  FROM ${qualifiedTable}
  WHERE ${predicate}
), hashed AS (
  SELECT key_text, MD5(key_text) AS key_hash, MD5(content_text) AS content_hash
  FROM canonical
)`;
}

export function checksumQuery(
  engine: Engine,
  mapping: TableMapping,
  sourceColumns: Column[],
  actualColumns: Column[],
  qualifiedTable: string,
  predicate: string,
  bucketPrefixLength = 2,
): string {
  if (!Number.isSafeInteger(bucketPrefixLength) || bucketPrefixLength < 2 || bucketPrefixLength > 4) throw new Error("Checksum bucket prefix length must be an integer from 2 to 4");
  const countCast = engine === "postgres" ? "COUNT(*)::text" : "COUNT(*)";
  const keyAggregate = engine === "postgres"
    ? "MD5(STRING_AGG(key_hash, '' ORDER BY key_text, content_hash))"
    : "MD5(LISTAGG(key_hash, '') WITHIN GROUP (ORDER BY key_text, content_hash))";
  const contentAggregate = engine === "postgres"
    ? "MD5(STRING_AGG(content_hash, '' ORDER BY key_text, content_hash))"
    : "MD5(LISTAGG(content_hash, '') WITHIN GROUP (ORDER BY key_text, content_hash))";
  return `${canonicalCte(engine, mapping, sourceColumns, actualColumns, qualifiedTable, predicate)}, bucketed AS (
  SELECT key_text, key_hash, content_hash, SUBSTR(key_hash, 1, ${bucketPrefixLength}) AS bucket_id
  FROM hashed
)
SELECT bucket_id, ${countCast} AS row_count,
       ${keyAggregate} AS key_checksum,
       ${contentAggregate} AS content_checksum
FROM bucketed
GROUP BY bucket_id
ORDER BY bucket_id`;
}

export function fingerprintQuery(
  engine: Engine,
  mapping: TableMapping,
  sourceColumns: Column[],
  actualColumns: Column[],
  qualifiedTable: string,
  predicate: string,
  bucketId: string,
  bucketPrefixLength: number,
  limit: number,
): string {
  if (!/^[0-9a-f]{2,4}$/.test(bucketId) || bucketId.length !== bucketPrefixLength) throw new Error(`Invalid checksum bucket id: ${bucketId}`);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Fingerprint row limit must be a positive safe integer");
  return `${canonicalCte(engine, mapping, sourceColumns, actualColumns, qualifiedTable, predicate)}
SELECT ${stringLiteral(bucketId)} AS bucket_id, key_hash, content_hash
FROM hashed
WHERE SUBSTR(key_hash, 1, ${bucketPrefixLength}) = ${stringLiteral(bucketId)}
ORDER BY key_hash, content_hash
LIMIT ${limit}`;
}

export function checksumBucketPrefixLength(rowCount: number, targetRowsPerBucket = 50_000): number {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("Checksum row count must be a safe non-negative integer");
  if (!Number.isSafeInteger(targetRowsPerBucket) || targetRowsPerBucket < 1) throw new Error("Checksum target rows per bucket must be positive");
  if (rowCount === 0) return 2;
  const requiredBuckets = Math.ceil(rowCount / targetRowsPerBucket);
  return Math.min(4, Math.max(2, Math.ceil(Math.log(requiredBuckets) / Math.log(16))));
}

function field(row: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? row[key] : undefined;
}

export function parseChecksumBuckets(rows: Record<string, unknown>[]): ChecksumBucket[] {
  return rows.map((row) => {
    const rowCount = Number(field(row, "row_count"));
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("Checksum bucket row count is invalid");
    return { id: String(field(row, "bucket_id")), rowCount, keyChecksum: String(field(row, "key_checksum")), contentChecksum: String(field(row, "content_checksum")) };
  });
}

export function parseFingerprintRows(rows: Record<string, unknown>[]): FingerprintRow[] {
  return rows.map((row) => {
    const bucketId = String(field(row, "bucket_id"));
    const keyHash = String(field(row, "key_hash"));
    const contentHash = String(field(row, "content_hash"));
    if (!/^[0-9a-f]{2,4}$/i.test(bucketId) || !/^[0-9a-f]{32}$/i.test(keyHash) || !/^[0-9a-f]{32}$/i.test(contentHash)) throw new Error("Database returned an invalid reconciliation fingerprint");
    return { bucketId: bucketId.toLowerCase(), keyHash: keyHash.toLowerCase(), contentHash: contentHash.toLowerCase() };
  });
}

export function mismatchedBucketIds(source: ChecksumBucket[], target: ChecksumBucket[]): string[] {
  const sourceById = new Map(source.map((bucket) => [bucket.id, bucket]));
  const targetById = new Map(target.map((bucket) => [bucket.id, bucket]));
  return [...new Set([...sourceById.keys(), ...targetById.keys()])].sort().filter((id) => {
    const expected = sourceById.get(id);
    const observed = targetById.get(id);
    return !expected || !observed || expected.rowCount !== observed.rowCount || expected.keyChecksum !== observed.keyChecksum || expected.contentChecksum !== observed.contentChecksum;
  });
}

function grouped(rows: FingerprintRow[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const hashes = result.get(row.keyHash) ?? [];
    hashes.push(row.contentHash);
    result.set(row.keyHash, hashes);
  }
  for (const hashes of result.values()) hashes.sort();
  return result;
}

export function compareFingerprints(bucketId: string, source: FingerprintRow[], target: FingerprintRow[]): RowDifference[] {
  const sourceByKey = grouped(source);
  const targetByKey = grouped(target);
  const differences: RowDifference[] = [];
  for (const keyFingerprint of [...new Set([...sourceByKey.keys(), ...targetByKey.keys()])].sort()) {
    const expected = sourceByKey.get(keyFingerprint) ?? [];
    const observed = targetByKey.get(keyFingerprint) ?? [];
    if (expected.length === 0) differences.push({ bucketId, keyFingerprint, kind: "unexpected-target", sourceRowCount: 0, targetRowCount: observed.length });
    else if (observed.length === 0) differences.push({ bucketId, keyFingerprint, kind: "missing-target", sourceRowCount: expected.length, targetRowCount: 0 });
    else if (JSON.stringify(expected) !== JSON.stringify(observed)) differences.push({ bucketId, keyFingerprint, kind: "content-mismatch", sourceRowCount: expected.length, targetRowCount: observed.length });
  }
  return differences;
}

export function comparisonRuleDescriptions(mapping: TableMapping): string[] {
  const rules: string[] = [];
  if (mapping.targetPrimaryKey) rules.push(`key rename: ${mapping.primaryKey.join("+")} -> ${mapping.targetPrimaryKey.join("+")}`);
  if (mapping.targetFreshnessColumn) rules.push(`freshness rename: ${mapping.freshnessColumn} -> ${mapping.targetFreshnessColumn}`);
  for (const comparison of mapping.columnComparisons ?? []) {
    const target = comparison.target ?? comparison.source;
    const operations = [comparison.target && comparison.target !== comparison.source ? `rename to ${target}` : undefined, comparison.normalize, comparison.valueMap ? `${Object.keys(comparison.valueMap).length} accepted value mapping(s)` : undefined].filter(Boolean);
    rules.push(`${comparison.source} -> ${target}${operations.length ? ` (${operations.join(", ")})` : " (strict)"}`);
  }
  return rules;
}

export function emptyReconciliationDetails(mismatchedBucketCount: number): ReconciliationDetails {
  return { privacy: "hashed-primary-key", mismatchedBucketCount, inspectedBucketCount: 0, complete: false, differences: [], skippedBuckets: [] };
}
