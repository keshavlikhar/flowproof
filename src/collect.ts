import { checksumQuery, parseChecksumBuckets } from "./checksum.ts";
import type { Config, CostObservation, ReplicationObservation, Snapshot, TableMapping, TableObservation } from "./types.ts";
import type { LiveClients, QueryClient } from "./clients.ts";

export interface CollectionWindow {
  since: string;
  until: string;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function table(value: string): [string, string] {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error(`Table must be schema.table: ${value}`);
  return [identifier(parts[0]), identifier(parts[1])];
}

function field(row: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? row[key] : undefined;
}

function count(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is not a safe non-negative integer`);
  return parsed;
}

function timestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Database returned an invalid freshness timestamp: ${String(value)}`);
  return parsed.toISOString();
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return count(value, label);
}

function postgresDistinct(keys: string[]): string {
  const safe = keys.map(identifier);
  if (!safe.length) return "NULL";
  return safe.length === 1 ? safe[0] : `(${safe.join(", ")})`;
}

function snowflakeDistinct(keys: string[]): string {
  const safe = keys.map(identifier);
  return safe.length ? safe.join(", ") : "NULL";
}

async function postgresObservation(client: QueryClient, mapping: TableMapping, window: CollectionWindow): Promise<TableObservation> {
  const [schema, name] = table(mapping.source);
  const columnsResult = await client.query(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
    [schema, name],
  );
  const freshness = identifier(mapping.freshnessColumn);
  const distinct = postgresDistinct(mapping.primaryKey);
  const metricsResult = await client.query(
    `SELECT COUNT(*)::text AS row_count, COUNT(DISTINCT ${distinct})::text AS distinct_primary_keys, MAX(${freshness}) AS max_freshness FROM ${schema}.${name} WHERE ${freshness} >= $1::timestamptz AND ${freshness} < $2::timestamptz`,
    [window.since, window.until],
  );
  const metrics = metricsResult.rows[0] ?? {};
  const columns = columnsResult.rows.map((row) => ({
    name: String(field(row, "column_name")),
    type: String(field(row, "data_type")),
    nullable: String(field(row, "is_nullable")).toUpperCase() === "YES",
  }));
  let checksumSql: string | undefined;
  let checksumUnavailableReason: string | undefined;
  try {
    checksumSql = checksumQuery(
      "postgres",
      mapping,
      columns,
      `${schema}.${name}`,
      `${freshness} >= $1::timestamptz AND ${freshness} < $2::timestamptz`,
    );
  } catch (error) {
    checksumUnavailableReason = error instanceof Error ? error.message : String(error);
  }
  const checksumBuckets = checksumSql
    ? parseChecksumBuckets((await client.query(checksumSql, [window.since, window.until])).rows)
    : undefined;
  return {
    name: mapping.source,
    columns,
    rowCount: count(field(metrics, "row_count"), `${mapping.source} row count`),
    distinctPrimaryKeys: count(field(metrics, "distinct_primary_keys"), `${mapping.source} distinct key count`),
    maxFreshnessValue: timestamp(field(metrics, "max_freshness")),
    checksumBuckets,
    checksumUnavailableReason,
  };
}

async function snowflakeObservation(
  client: QueryClient,
  mapping: TableMapping,
  sourceColumns: TableObservation["columns"],
  window: CollectionWindow,
): Promise<TableObservation> {
  const [schema, name] = table(mapping.target);
  const columnsResult = await client.query(
    "SELECT column_name, data_type, is_nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    [schema.toUpperCase(), name.toUpperCase()],
  );
  const columns = columnsResult.rows.map((row) => ({
    name: String(field(row, "column_name")),
    type: String(field(row, "data_type")),
    nullable: String(field(row, "is_nullable")).toUpperCase() === "YES",
  }));
  const targetColumnNames = new Set(columns.map((column) => column.name.toLowerCase()));
  const freshness = identifier(mapping.freshnessColumn);
  const distinct = snowflakeDistinct(mapping.primaryKey);
  const softDelete = mapping.targetSoftDeleteColumn ? identifier(mapping.targetSoftDeleteColumn) : undefined;
  if (softDelete && !targetColumnNames.has(softDelete.toLowerCase())) {
    throw new Error(`Configured soft-delete column ${softDelete} is missing from ${mapping.target}`);
  }
  const applyTimestamp = mapping.targetApplyTimestampColumn ? identifier(mapping.targetApplyTimestampColumn) : undefined;
  if (applyTimestamp && !targetColumnNames.has(applyTimestamp.toLowerCase())) {
    throw new Error(`Configured apply timestamp column ${applyTimestamp} is missing from ${mapping.target}`);
  }
  const activePredicate = softDelete ? ` AND COALESCE(${softDelete}, FALSE) = FALSE` : "";
  const windowPredicate = `${freshness} >= TO_TIMESTAMP_TZ(?) AND ${freshness} < TO_TIMESTAMP_TZ(?)${activePredicate}`;
  const deliveryLag = applyTimestamp
    ? `MAX(GREATEST(0, DATEDIFF('second', ${freshness}, ${applyTimestamp})))`
    : "NULL";
  const metricsResult = await client.query(
    `SELECT COUNT(*) AS row_count, COUNT(DISTINCT ${distinct}) AS distinct_primary_keys, MAX(${freshness}) AS max_freshness, ${deliveryLag} AS max_delivery_lag_seconds FROM ${schema}.${name} WHERE ${windowPredicate}`,
    [window.since, window.until],
  );
  const metrics = metricsResult.rows[0] ?? {};
  let checksumSql: string | undefined;
  let checksumUnavailableReason: string | undefined;
  try {
    checksumSql = checksumQuery("snowflake", mapping, sourceColumns, `${schema}.${name}`, windowPredicate);
  } catch (error) {
    checksumUnavailableReason = error instanceof Error ? error.message : String(error);
  }
  const checksumBuckets = checksumSql
    ? parseChecksumBuckets((await client.query(checksumSql, [window.since, window.until])).rows)
    : undefined;
  return {
    name: mapping.target,
    columns,
    rowCount: count(field(metrics, "row_count"), `${mapping.target} row count`),
    distinctPrimaryKeys: count(field(metrics, "distinct_primary_keys"), `${mapping.target} distinct key count`),
    maxFreshnessValue: timestamp(field(metrics, "max_freshness")),
    maxDeliveryLagSeconds: optionalCount(field(metrics, "max_delivery_lag_seconds"), `${mapping.target} delivery lag`),
    checksumBuckets,
    checksumUnavailableReason,
    activeRowFilter: softDelete ? `${softDelete} = FALSE` : undefined,
  };
}

async function replicationObservation(client: QueryClient, config: NonNullable<Config["replication"]>): Promise<ReplicationObservation> {
  const result = await client.query(
    `SELECT slot_name, active, restart_lsn::text AS restart_lsn,
            confirmed_flush_lsn::text AS confirmed_flush_lsn,
            pg_current_wal_lsn()::text AS current_wal_lsn,
            pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::text AS unconfirmed_wal_bytes,
            pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::text AS retained_wal_bytes,
            wal_status
     FROM pg_replication_slots
     WHERE slot_name = $1 AND slot_type = 'logical'`,
    [config.postgresSlotName],
  );
  const row = result.rows[0];
  if (!row) return { slotName: config.postgresSlotName, found: false };
  return {
    slotName: String(field(row, "slot_name")),
    found: true,
    active: field(row, "active") === true || String(field(row, "active")).toLowerCase() === "true",
    restartLsn: field(row, "restart_lsn") === null ? undefined : String(field(row, "restart_lsn")),
    confirmedFlushLsn: field(row, "confirmed_flush_lsn") === null ? undefined : String(field(row, "confirmed_flush_lsn")),
    currentWalLsn: field(row, "current_wal_lsn") === null ? undefined : String(field(row, "current_wal_lsn")),
    unconfirmedWalBytes: optionalCount(field(row, "unconfirmed_wal_bytes"), "unconfirmed WAL bytes"),
    retainedWalBytes: optionalCount(field(row, "retained_wal_bytes"), "retained WAL bytes"),
    walStatus: field(row, "wal_status") === null ? undefined : String(field(row, "wal_status")),
  };
}

async function costObservation(client: QueryClient, environment: NodeJS.ProcessEnv): Promise<CostObservation | undefined> {
  const taskName = environment.FLOWPROOF_SNOWFLAKE_TASK_NAME;
  const rateValue = environment.FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD;
  if (!taskName || !rateValue) return undefined;
  const rate = Number(rateValue);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD must be a positive number");
  const result = await client.query(
    "SELECT COALESCE(SUM(CREDITS_USED), 0) AS credits_used FROM SNOWFLAKE.ACCOUNT_USAGE.SERVERLESS_TASK_HISTORY WHERE TASK_NAME = ? AND START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())",
    [taskName.toUpperCase()],
  );
  const credits = Number(field(result.rows[0] ?? {}, "credits_used"));
  if (!Number.isFinite(credits) || credits < 0) throw new Error("Snowflake returned invalid serverless credit usage");
  return {
    currentMonthlyUsd: credits * rate,
    projectedMonthlyUsd: credits * rate,
    method: "30-day Snowflake serverless task compute only; storage, transfer, and other compute are not yet included",
    confidence: "low",
  };
}

export async function collectSnapshot(
  config: Config,
  clients: LiveClients,
  window: CollectionWindow,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Snapshot> {
  const since = new Date(window.since);
  const until = new Date(window.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
    throw new Error("Collection window requires valid timestamps with --since earlier than --until");
  }
  const source: Snapshot["source"] = { tables: {} };
  const target: Snapshot["target"] = { tables: {} };
  for (const mapping of config.tables) {
    const sourceObservation = await postgresObservation(clients.postgres, mapping, window);
    source.tables[mapping.source] = sourceObservation;
    target.tables[mapping.target] = await snowflakeObservation(clients.snowflake, mapping, sourceObservation.columns, window);
  }
  return {
    version: config.version,
    observedAt: until.toISOString(),
    window: { since: since.toISOString(), until: until.toISOString() },
    source,
    target,
    replication: config.replication ? await replicationObservation(clients.postgres, config.replication) : undefined,
    cost: await costObservation(clients.snowflake, environment),
  };
}
