import {
  checksumBucketPrefixLength,
  checksumQuery,
  compareFingerprints,
  emptyReconciliationDetails,
  fingerprintQuery,
  mismatchedBucketIds,
  parseChecksumBuckets,
  parseFingerprintRows,
} from "./checksum.ts";
import type { Config, CostObservation, ReplicationObservation, Snapshot, SystemObservation, TableMapping, TableObservation } from "./types.ts";
import type { LiveClients, QueryClient } from "./clients.ts";
import { targetFreshness, targetPrimaryKeys } from "./mapping.ts";

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

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a finite number`);
  return parsed;
}

function columnNumber(row: Record<string, unknown>, name: string): number | undefined {
  return optionalNumber(field(row, name), `column ${name}`);
}

function columns(rows: Record<string, unknown>[]): TableObservation["columns"] {
  return rows.map((row) => ({
    name: String(field(row, "column_name")),
    type: String(field(row, "data_type")),
    nullable: String(field(row, "is_nullable")).toUpperCase() === "YES",
    numericPrecision: columnNumber(row, "numeric_precision"),
    numericScale: columnNumber(row, "numeric_scale"),
    characterMaximumLength: columnNumber(row, "character_maximum_length"),
    datetimePrecision: columnNumber(row, "datetime_precision"),
  }));
}

async function systemObservation(client: QueryClient, engine: "postgres" | "snowflake"): Promise<SystemObservation> {
  const sql = engine === "postgres"
    ? "SELECT CURRENT_TIMESTAMP AS database_time, current_setting('TimeZone') AS session_timezone, current_setting('server_version') AS database_version"
    : "SELECT CURRENT_TIMESTAMP() AS database_time, 'UTC' AS session_timezone, CURRENT_VERSION() AS database_version";
  const row = (await client.query(sql)).rows[0] ?? {};
  const databaseTime = timestamp(field(row, "database_time"));
  if (!databaseTime) throw new Error(`${engine} did not return its database clock`);
  return {
    databaseTime,
    sessionTimezone: String(field(row, "session_timezone")),
    databaseVersion: String(field(row, "database_version")),
  };
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

async function postgresObservation(client: QueryClient, mapping: TableMapping, window: CollectionWindow, maxRowsPerTable?: number): Promise<TableObservation> {
  const [schema, name] = table(mapping.source);
  const columnsResult = await client.query(
    "SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, character_maximum_length, datetime_precision FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
    [schema, name],
  );
  const freshness = identifier(mapping.freshnessColumn);
  const distinct = postgresDistinct(mapping.primaryKey);
  const metricsResult = await client.query(
    `SELECT COUNT(*)::text AS row_count, COUNT(DISTINCT ${distinct})::text AS distinct_primary_keys, MAX(${freshness}) AS max_freshness FROM ${schema}.${name} WHERE ${freshness} >= $1::timestamptz AND ${freshness} < $2::timestamptz`,
    [window.since, window.until],
  );
  const metrics = metricsResult.rows[0] ?? {};
  const observedColumns = columns(columnsResult.rows);
  const rowCount = count(field(metrics, "row_count"), `${mapping.source} row count`);
  const bucketPrefixLength = checksumBucketPrefixLength(rowCount);
  let checksumSql: string | undefined;
  let checksumUnavailableReason: string | undefined;
  if (maxRowsPerTable !== undefined && rowCount > maxRowsPerTable) {
    checksumUnavailableReason = `row count ${rowCount} exceeds configured checksum scan limit ${maxRowsPerTable}`;
  } else try {
    checksumSql = checksumQuery(
      "postgres",
      mapping,
      observedColumns,
      observedColumns,
      `${schema}.${name}`,
      `${freshness} >= $1::timestamptz AND ${freshness} < $2::timestamptz`,
      bucketPrefixLength,
    );
  } catch (error) {
    checksumUnavailableReason = error instanceof Error ? error.message : String(error);
  }
  const checksumBuckets = checksumSql
    ? parseChecksumBuckets((await client.query(checksumSql, [window.since, window.until])).rows)
    : undefined;
  return {
    name: mapping.source,
    columns: observedColumns,
    rowCount,
    distinctPrimaryKeys: count(field(metrics, "distinct_primary_keys"), `${mapping.source} distinct key count`),
    maxFreshnessValue: timestamp(field(metrics, "max_freshness")),
    checksumBuckets,
    checksumBucketPrefixLength: checksumBuckets ? bucketPrefixLength : undefined,
    checksumUnavailableReason,
  };
}

async function snowflakeObservation(
  client: QueryClient,
  mapping: TableMapping,
  sourceColumns: TableObservation["columns"],
  sourceChecksumPrefixLength: number | undefined,
  sourceChecksumUnavailableReason: string | undefined,
  window: CollectionWindow,
): Promise<TableObservation> {
  const [schema, name] = table(mapping.target);
  const columnsResult = await client.query(
    "SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, character_maximum_length, datetime_precision FROM INFORMATION_SCHEMA.COLUMNS WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    [schema.toUpperCase(), name.toUpperCase()],
  );
  const observedColumns = columns(columnsResult.rows);
  const targetColumnNames = new Set(observedColumns.map((column) => column.name.toLowerCase()));
  const freshness = identifier(targetFreshness(mapping));
  const distinct = snowflakeDistinct(targetPrimaryKeys(mapping));
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
  const deliveryLagFields = applyTimestamp
    ? `MIN(DATEDIFF('second', ${freshness}, ${applyTimestamp})) AS min_delivery_lag_seconds,
       APPROX_PERCENTILE(DATEDIFF('second', ${freshness}, ${applyTimestamp}), 0.95) AS p95_delivery_lag_seconds,
       MAX(DATEDIFF('second', ${freshness}, ${applyTimestamp})) AS max_delivery_lag_seconds,
       COUNT_IF(${applyTimestamp} IS NOT NULL) AS delivery_lag_row_count,
       COUNT_IF(${applyTimestamp} IS NULL) AS missing_delivery_timestamp_count`
    : "NULL AS min_delivery_lag_seconds, NULL AS p95_delivery_lag_seconds, NULL AS max_delivery_lag_seconds, 0 AS delivery_lag_row_count, COUNT(*) AS missing_delivery_timestamp_count";
  const metricsResult = await client.query(
    `SELECT COUNT(*) AS row_count, COUNT(DISTINCT ${distinct}) AS distinct_primary_keys, MAX(${freshness}) AS max_freshness, ${deliveryLagFields} FROM ${schema}.${name} WHERE ${windowPredicate}`,
    [window.since, window.until],
  );
  const metrics = metricsResult.rows[0] ?? {};
  const rowCount = count(field(metrics, "row_count"), `${mapping.target} row count`);
  let checksumSql: string | undefined;
  let checksumUnavailableReason = sourceChecksumUnavailableReason;
  if (!checksumUnavailableReason) {
    try {
      checksumSql = checksumQuery(
        "snowflake",
        mapping,
        sourceColumns,
        observedColumns,
        `${schema}.${name}`,
        windowPredicate,
        sourceChecksumPrefixLength ?? checksumBucketPrefixLength(rowCount),
      );
    } catch (error) {
      checksumUnavailableReason = error instanceof Error ? error.message : String(error);
    }
  }
  const checksumBuckets = checksumSql
    ? parseChecksumBuckets((await client.query(checksumSql, [window.since, window.until])).rows)
    : undefined;
  return {
    name: mapping.target,
    columns: observedColumns,
    rowCount,
    distinctPrimaryKeys: count(field(metrics, "distinct_primary_keys"), `${mapping.target} distinct key count`),
    maxFreshnessValue: timestamp(field(metrics, "max_freshness")),
    minDeliveryLagSeconds: optionalNumber(field(metrics, "min_delivery_lag_seconds"), `${mapping.target} minimum delivery lag`),
    p95DeliveryLagSeconds: optionalNumber(field(metrics, "p95_delivery_lag_seconds"), `${mapping.target} p95 delivery lag`),
    maxDeliveryLagSeconds: optionalNumber(field(metrics, "max_delivery_lag_seconds"), `${mapping.target} maximum delivery lag`),
    deliveryLagRowCount: optionalCount(field(metrics, "delivery_lag_row_count"), `${mapping.target} delivery lag row count`),
    missingDeliveryTimestampCount: optionalCount(field(metrics, "missing_delivery_timestamp_count"), `${mapping.target} missing delivery timestamp count`),
    checksumBuckets,
    checksumBucketPrefixLength: checksumBuckets ? sourceChecksumPrefixLength ?? checksumBucketPrefixLength(rowCount) : undefined,
    checksumUnavailableReason,
    activeRowFilter: softDelete ? `${softDelete} = FALSE` : undefined,
  };
}

async function reconciliationDetails(
  config: Config,
  clients: LiveClients,
  mapping: TableMapping,
  source: TableObservation,
  target: TableObservation,
  window: CollectionWindow,
): Promise<void> {
  if (!source.checksumBuckets || !target.checksumBuckets || !source.checksumBucketPrefixLength) return;
  const ids = mismatchedBucketIds(source.checksumBuckets, target.checksumBuckets);
  if (!ids.length) return;
  const details = emptyReconciliationDetails(ids.length);
  target.reconciliationDetails = details;
  const maxBuckets = config.reconciliation?.maxMismatchBuckets ?? 5;
  const maxRows = config.reconciliation?.maxMismatchRowsPerBucket ?? 1000;
  const sourceById = new Map(source.checksumBuckets.map((bucket) => [bucket.id, bucket]));
  const targetById = new Map(target.checksumBuckets.map((bucket) => [bucket.id, bucket]));
  const [sourceSchema, sourceTable] = table(mapping.source);
  const [targetSchema, targetTable] = table(mapping.target);
  const sourceFreshness = identifier(mapping.freshnessColumn);
  const targetFreshnessColumn = identifier(targetFreshness(mapping));
  const softDelete = mapping.targetSoftDeleteColumn ? identifier(mapping.targetSoftDeleteColumn) : undefined;
  const sourcePredicate = `${sourceFreshness} >= $1::timestamptz AND ${sourceFreshness} < $2::timestamptz`;
  const targetPredicate = `${targetFreshnessColumn} >= TO_TIMESTAMP_TZ(?) AND ${targetFreshnessColumn} < TO_TIMESTAMP_TZ(?)${softDelete ? ` AND COALESCE(${softDelete}, FALSE) = FALSE` : ""}`;
  for (const id of ids) {
    if (details.inspectedBucketCount >= maxBuckets) {
      details.skippedBuckets.push({ id, reason: `inspection limit of ${maxBuckets} bucket(s) reached` });
      continue;
    }
    const expectedRows = sourceById.get(id)?.rowCount ?? 0;
    const observedRows = targetById.get(id)?.rowCount ?? 0;
    if (expectedRows > maxRows || observedRows > maxRows) {
      details.skippedBuckets.push({ id, reason: `bucket contains ${Math.max(expectedRows, observedRows)} row(s), above detail limit ${maxRows}` });
      continue;
    }
    const sourceSql = fingerprintQuery("postgres", mapping, source.columns, source.columns, `${sourceSchema}.${sourceTable}`, sourcePredicate, id, source.checksumBucketPrefixLength, maxRows + 1);
    const targetSql = fingerprintQuery("snowflake", mapping, source.columns, target.columns, `${targetSchema}.${targetTable}`, targetPredicate, id, source.checksumBucketPrefixLength, maxRows + 1);
    const sourceRows = parseFingerprintRows((await clients.postgres.query(sourceSql, [window.since, window.until])).rows);
    const targetRows = parseFingerprintRows((await clients.snowflake.query(targetSql, [window.since, window.until])).rows);
    if (sourceRows.length !== expectedRows || targetRows.length !== observedRows || sourceRows.length > maxRows || targetRows.length > maxRows) {
      details.skippedBuckets.push({ id, reason: "bucket changed between summary and bounded detail collection" });
      continue;
    }
    details.inspectedBucketCount += 1;
    details.differences.push(...compareFingerprints(id, sourceRows, targetRows));
  }
  details.complete = details.inspectedBucketCount === ids.length && details.skippedBuckets.length === 0;
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
  const rateValue = environment.FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD;
  if (!rateValue) return undefined;
  const rate = Number(rateValue);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD must be a positive number");
  type Component = NonNullable<CostObservation["components"]>[number];
  const allowed = new Set(["warehouse", "serverless-task", "storage", "transfer"]);
  const expected = (environment.FLOWPROOF_COST_EXPECTED_COMPONENTS ?? "warehouse,serverless-task,storage,transfer")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!expected.length || expected.some((value) => !allowed.has(value))) {
    throw new Error("FLOWPROOF_COST_EXPECTED_COMPONENTS supports warehouse, serverless-task, storage, and transfer");
  }
  const components: Component[] = [];
  if (expected.includes("warehouse")) {
    const warehouse = requiredEnvironment(environment, "FLOWPROOF_SNOWFLAKE_WAREHOUSE");
    try {
      const result = await client.query(
        "SELECT COALESCE(SUM(CREDITS_USED), 0) AS credits_used, MAX(END_TIME) AS data_through FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY WHERE WAREHOUSE_NAME = ? AND START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())",
        [warehouse.toUpperCase()],
      );
      const credits = optionalNumber(field(result.rows[0] ?? {}, "credits_used"), "warehouse credits") ?? 0;
      components.push({ name: "warehouse", monthlyUsd: credits * rate, credits, source: "30-day WAREHOUSE_METERING_HISTORY", status: "measured", dataThrough: timestamp(field(result.rows[0] ?? {}, "data_through")) });
    } catch (error) {
      components.push({ name: "warehouse", source: "WAREHOUSE_METERING_HISTORY", status: "unavailable", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (expected.includes("serverless-task")) {
    const taskName = environment.FLOWPROOF_SNOWFLAKE_TASK_NAME;
    if (!taskName) components.push({ name: "serverless-task", source: "SERVERLESS_TASK_HISTORY", status: "unavailable", reason: "FLOWPROOF_SNOWFLAKE_TASK_NAME is not configured" });
    else try {
      const result = await client.query(
        "SELECT COALESCE(SUM(CREDITS_USED), 0) AS credits_used, MAX(END_TIME) AS data_through FROM SNOWFLAKE.ACCOUNT_USAGE.SERVERLESS_TASK_HISTORY WHERE TASK_NAME = ? AND START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())",
        [taskName.toUpperCase()],
      );
      const credits = optionalNumber(field(result.rows[0] ?? {}, "credits_used"), "serverless task credits") ?? 0;
      components.push({ name: "serverless-task", monthlyUsd: credits * rate, credits, source: "30-day SERVERLESS_TASK_HISTORY", status: "measured", dataThrough: timestamp(field(result.rows[0] ?? {}, "data_through")) });
    } catch (error) {
      components.push({ name: "serverless-task", source: "SERVERLESS_TASK_HISTORY", status: "unavailable", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [name, variable] of [["storage", "FLOWPROOF_SNOWFLAKE_STORAGE_MONTHLY_USD"], ["transfer", "FLOWPROOF_SNOWFLAKE_TRANSFER_MONTHLY_USD"]] as const) {
    if (!expected.includes(name)) continue;
    const raw = environment[variable];
    const monthlyUsd = raw === undefined ? undefined : Number(raw);
    if (monthlyUsd === undefined) components.push({ name, source: "configured monthly allocation", status: "unavailable", reason: `${variable} is not configured` });
    else if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) throw new Error(`${variable} must be a non-negative number`);
    else components.push({ name, monthlyUsd, source: "configured monthly allocation", status: "configured" });
  }
  const missingComponents = components.filter((component) => component.status === "unavailable").map((component) => component.name);
  const projectedMonthlyUsd = components.reduce((total, component) => total + (component.monthlyUsd ?? 0), 0);
  const coverage = missingComponents.length ? "partial" : "complete";
  return {
    currentMonthlyUsd: projectedMonthlyUsd,
    projectedMonthlyUsd,
    method: `30-day measured credits at $${rate.toFixed(2)}/credit plus explicit monthly allocations; Snowflake ACCOUNT_USAGE can lag`,
    confidence: coverage === "complete" ? "medium" : "low",
    coverage,
    components,
    missingComponents,
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
  source.system = await systemObservation(clients.postgres, "postgres");
  target.system = await systemObservation(clients.snowflake, "snowflake");
  const settleDelaySeconds = config.reconciliation?.settleDelaySeconds ?? 0;
  const latestDatabaseTime = Math.min(Date.parse(source.system.databaseTime), Date.parse(target.system.databaseTime));
  const latestClosedTime = latestDatabaseTime - settleDelaySeconds * 1000;
  const closed = until.getTime() <= latestClosedTime;
  const stabilityCheck = config.reconciliation?.sourceStabilityCheck ?? config.version === 2;
  const maxRowsPerTable = config.reconciliation?.maxRowsPerTable;
  for (const mapping of config.tables) {
    const sourceObservation = await postgresObservation(clients.postgres, mapping, window, maxRowsPerTable);
    source.tables[mapping.source] = sourceObservation;
    const targetObservation = await snowflakeObservation(
      clients.snowflake,
      mapping,
      sourceObservation.columns,
      sourceObservation.checksumBucketPrefixLength,
      sourceObservation.checksumUnavailableReason,
      window,
    );
    target.tables[mapping.target] = targetObservation;
    await reconciliationDetails(config, clients, mapping, sourceObservation, targetObservation, window);
    if (stabilityCheck) {
      const recheck = await postgresObservation(clients.postgres, mapping, window, maxRowsPerTable);
      const initialFingerprint = JSON.stringify({
        columns: sourceObservation.columns,
        rowCount: sourceObservation.rowCount,
        distinctPrimaryKeys: sourceObservation.distinctPrimaryKeys,
        maxFreshnessValue: sourceObservation.maxFreshnessValue,
        checksumBuckets: sourceObservation.checksumBuckets,
      });
      const finalFingerprint = JSON.stringify({
        columns: recheck.columns,
        rowCount: recheck.rowCount,
        distinctPrimaryKeys: recheck.distinctPrimaryKeys,
        maxFreshnessValue: recheck.maxFreshnessValue,
        checksumBuckets: recheck.checksumBuckets,
      });
      sourceObservation.stableDuringCollection = initialFingerprint === finalFingerprint;
      sourceObservation.stabilityEvidence = sourceObservation.stableDuringCollection
        ? "source window fingerprint was unchanged before and after target collection"
        : "source window fingerprint changed while target evidence was collected";
    }
  }
  return {
    version: config.version,
    observedAt: new Date().toISOString(),
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      settleDelaySeconds,
      closed,
      closureReason: closed
        ? `window ended at least ${settleDelaySeconds}s before both observed database clocks`
        : `window ends after the safe cutoff ${new Date(latestClosedTime).toISOString()}`,
    },
    source,
    target,
    replication: config.replication ? await replicationObservation(clients.postgres, config.replication) : undefined,
    cost: await costObservation(clients.snowflake, environment),
  };
}
