import test from "node:test";
import assert from "node:assert/strict";
import { collectSnapshot } from "../src/collect.ts";
import type { QueryClient } from "../src/clients.ts";
import type { Config } from "../src/types.ts";

class FakeClient implements QueryClient {
  readonly calls: { sql: string; binds: unknown[] }[] = [];
  private readonly responses: Record<string, unknown>[][];
  constructor(responses: Record<string, unknown>[][]) { this.responses = responses; }
  async query(sql: string, binds: unknown[] = []) {
    this.calls.push({ sql, binds });
    return { rows: this.responses.shift() ?? [] };
  }
  async close() {}
}

const config: Config = {
  version: 1,
  pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  tables: [{
    source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at",
    checksumColumns: ["id"], targetSoftDeleteColumn: "_SNOWFLAKE_DELETED", targetApplyTimestampColumn: "_SNOWFLAKE_UPDATED_AT",
  }],
};

test("collects bounded metadata and metrics without retrieving source rows", async () => {
  const postgres = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "17.1" }],
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: new Date("2026-01-01T00:09:50Z") }],
    [{ bucket_id: "a1", row_count: "2", key_checksum: "keys", content_checksum: "content" }],
  ]);
  const snowflake = new FakeClient([
    [{ DATABASE_TIME: "2026-01-01T00:20:01Z", SESSION_TIMEZONE: "UTC", DATABASE_VERSION: "9.0" }],
    [
      { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", IS_NULLABLE: "NO" },
      { COLUMN_NAME: "_SNOWFLAKE_DELETED", DATA_TYPE: "BOOLEAN", IS_NULLABLE: "NO" },
      { COLUMN_NAME: "_SNOWFLAKE_UPDATED_AT", DATA_TYPE: "TIMESTAMP_NTZ", IS_NULLABLE: "NO" },
    ],
    [{ ROW_COUNT: 2, DISTINCT_PRIMARY_KEYS: 2, MAX_FRESHNESS: "2026-01-01T00:09:30Z", MIN_DELIVERY_LAG_SECONDS: 10, P95_DELIVERY_LAG_SECONDS: 19, MAX_DELIVERY_LAG_SECONDS: 20, DELIVERY_LAG_ROW_COUNT: 2, MISSING_DELIVERY_TIMESTAMP_COUNT: 0 }],
    [{ BUCKET_ID: "a1", ROW_COUNT: 2, KEY_CHECKSUM: "keys", CONTENT_CHECKSUM: "content" }],
  ]);
  const snapshot = await collectSnapshot(
    config,
    { postgres, snowflake },
    { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" },
    {},
  );
  assert.equal(snapshot.source.tables["public.orders"].rowCount, 2);
  assert.equal(snapshot.target.tables["RAW.ORDERS"].distinctPrimaryKeys, 2);
  assert.equal(snapshot.target.tables["RAW.ORDERS"].maxDeliveryLagSeconds, 20);
  assert.equal(snapshot.target.tables["RAW.ORDERS"].activeRowFilter, "_SNOWFLAKE_DELETED = FALSE");
  assert.equal(snapshot.source.tables["public.orders"].checksumBuckets?.[0].contentChecksum, "content");
  assert.equal(snapshot.window?.closed, true);
  assert.equal(snapshot.window?.settleDelaySeconds, 0);
  assert.match(postgres.calls[2].sql, /WHERE updated_at >= \$1/);
  assert.match(snowflake.calls[2].sql, /WHERE updated_at >= TO_TIMESTAMP_TZ\(\?\)/);
  assert.match(snowflake.calls[2].sql, /COALESCE\(_SNOWFLAKE_DELETED, FALSE\) = FALSE/);
  assert.match(snowflake.calls[2].sql, /DATEDIFF\('second', updated_at, _SNOWFLAKE_UPDATED_AT\)/);
  assert.match(postgres.calls[3].sql, /STRING_AGG/);
  assert.match(snowflake.calls[3].sql, /LISTAGG/);
  assert.deepEqual(postgres.calls[2].binds, ["2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z"]);
  assert.equal(snapshot.cost, undefined);
});

test("collects PostgreSQL logical replication-slot progress", async () => {
  const withReplication = structuredClone(config);
  withReplication.replication = { postgresSlotName: "snowflake_connector_test", maxUnconfirmedWalBytes: 1000, maxRetainedWalBytes: 2000 };
  const postgres = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "17.1" }],
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: "2026-01-01T00:09:50Z" }],
    [{ bucket_id: "a1", row_count: "2", key_checksum: "keys", content_checksum: "content" }],
    [{ slot_name: "snowflake_connector_test", active: true, restart_lsn: "0/100", confirmed_flush_lsn: "0/200", current_wal_lsn: "0/220", unconfirmed_wal_bytes: "32", retained_wal_bytes: "288", wal_status: "reserved", invalidation_reason: null }],
  ]);
  const snowflake = new FakeClient([
    [{ database_time: "2026-01-01T00:20:01Z", session_timezone: "UTC", database_version: "9.0" }],
    [
      { column_name: "ID", data_type: "NUMBER", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_DELETED", data_type: "BOOLEAN", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_UPDATED_AT", data_type: "TIMESTAMP_NTZ", is_nullable: "NO" },
    ],
    [{ row_count: 2, distinct_primary_keys: 2, max_freshness: "2026-01-01T00:09:30Z", min_delivery_lag_seconds: 10, p95_delivery_lag_seconds: 19, max_delivery_lag_seconds: 20, delivery_lag_row_count: 2, missing_delivery_timestamp_count: 0 }],
    [{ bucket_id: "a1", row_count: 2, key_checksum: "keys", content_checksum: "content" }],
  ]);
  const snapshot = await collectSnapshot(withReplication, { postgres, snowflake }, { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" }, {});
  assert.equal(snapshot.replication?.confirmedFlushLsn, "0/200");
  assert.equal(snapshot.replication?.unconfirmedWalBytes, 32);
  assert.match(postgres.calls[4].sql, /pg_replication_slots/);
  assert.deepEqual(postgres.calls[4].binds, ["snowflake_connector_test"]);
});

test("does not scan target checksums when the source exceeds the configured limit", async () => {
  const limited = structuredClone(config);
  limited.reconciliation = { maxRowsPerTable: 1, sourceStabilityCheck: false };
  const postgres = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "17.1" }],
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: "2026-01-01T00:09:50Z" }],
  ]);
  const snowflake = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "9.0" }],
    [
      { column_name: "ID", data_type: "NUMBER", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_DELETED", data_type: "BOOLEAN", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_UPDATED_AT", data_type: "TIMESTAMP_NTZ", is_nullable: "NO" },
    ],
    [{ row_count: 2, distinct_primary_keys: 2, max_freshness: "2026-01-01T00:09:30Z", min_delivery_lag_seconds: 10, p95_delivery_lag_seconds: 19, max_delivery_lag_seconds: 20, delivery_lag_row_count: 2, missing_delivery_timestamp_count: 0 }],
  ]);
  const snapshot = await collectSnapshot(limited, { postgres, snowflake }, { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" }, {});
  assert.equal(postgres.calls.length, 3);
  assert.equal(snowflake.calls.length, 3);
  assert.match(snapshot.source.tables["public.orders"].checksumUnavailableReason ?? "", /exceeds configured checksum scan limit/);
  assert.equal(snapshot.target.tables["RAW.ORDERS"].checksumUnavailableReason, snapshot.source.tables["public.orders"].checksumUnavailableReason);
});

test("collects transparent warehouse cost components without failing on omitted components", async () => {
  const postgres = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "17.1" }],
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: "2026-01-01T00:09:50Z" }],
    [{ bucket_id: "a1", row_count: "2", key_checksum: "keys", content_checksum: "content" }],
  ]);
  const snowflake = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "9.0" }],
    [
      { column_name: "ID", data_type: "NUMBER", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_DELETED", data_type: "BOOLEAN", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_UPDATED_AT", data_type: "TIMESTAMP_NTZ", is_nullable: "NO" },
    ],
    [{ row_count: 2, distinct_primary_keys: 2, max_freshness: "2026-01-01T00:09:30Z", min_delivery_lag_seconds: 10, p95_delivery_lag_seconds: 19, max_delivery_lag_seconds: 20, delivery_lag_row_count: 2, missing_delivery_timestamp_count: 0 }],
    [{ bucket_id: "a1", row_count: 2, key_checksum: "keys", content_checksum: "content" }],
    [{ credits_used: 3, data_through: "2026-01-01T00:15:00Z" }],
  ]);
  const snapshot = await collectSnapshot(
    config,
    { postgres, snowflake },
    { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" },
    { FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD: "2.50", FLOWPROOF_SNOWFLAKE_WAREHOUSE: "PILOT_WH", FLOWPROOF_COST_EXPECTED_COMPONENTS: "warehouse" },
  );
  assert.equal(snapshot.cost?.projectedMonthlyUsd, 7.5);
  assert.equal(snapshot.cost?.coverage, "complete");
  assert.equal(snapshot.cost?.components?.[0].credits, 3);
});

test("rejects an invalid collection window before querying databases", async () => {
  const postgres = new FakeClient([]);
  const snowflake = new FakeClient([]);
  await assert.rejects(
    collectSnapshot(config, { postgres, snowflake }, { since: "2026-01-02", until: "2026-01-01" }, {}),
    /since earlier than --until/,
  );
  assert.equal(postgres.calls.length, 0);
  assert.equal(snowflake.calls.length, 0);
});

test("drills into a small mismatched bucket using only hashed key fingerprints", async () => {
  const postgres = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "17.1" }],
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: "2026-01-01T00:09:50Z" }],
    [{ bucket_id: "a1", row_count: "2", key_checksum: "source-keys", content_checksum: "source-content" }],
    [
      { bucket_id: "a1", key_hash: "11111111111111111111111111111111", content_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { bucket_id: "a1", key_hash: "22222222222222222222222222222222", content_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ],
  ]);
  const snowflake = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "9.0" }],
    [
      { column_name: "ID", data_type: "NUMBER", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_DELETED", data_type: "BOOLEAN", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_UPDATED_AT", data_type: "TIMESTAMP_NTZ", is_nullable: "NO" },
    ],
    [{ row_count: 2, distinct_primary_keys: 2, max_freshness: "2026-01-01T00:09:30Z", min_delivery_lag_seconds: 10, p95_delivery_lag_seconds: 19, max_delivery_lag_seconds: 20, delivery_lag_row_count: 2, missing_delivery_timestamp_count: 0 }],
    [{ bucket_id: "a1", row_count: 2, key_checksum: "target-keys", content_checksum: "target-content" }],
    [
      { bucket_id: "a1", key_hash: "22222222222222222222222222222222", content_hash: "cccccccccccccccccccccccccccccccc" },
      { bucket_id: "a1", key_hash: "33333333333333333333333333333333", content_hash: "dddddddddddddddddddddddddddddddd" },
    ],
  ]);
  const snapshot = await collectSnapshot(config, { postgres, snowflake }, { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" }, {});
  const detail = snapshot.target.tables["RAW.ORDERS"].reconciliationDetails;
  assert.equal(detail?.complete, true);
  assert.equal(detail?.inspectedBucketCount, 1);
  assert.deepEqual(detail?.differences.map((difference) => difference.kind), ["missing-target", "content-mismatch", "unexpected-target"]);
  assert.match(postgres.calls[4].sql, /SELECT 'a1' AS bucket_id, key_hash, content_hash/);
  assert.doesNotMatch(postgres.calls[4].sql, /SELECT id[, ]/);
});

test("collects renamed and normalized transformation contracts on both systems", async () => {
  const transformed = structuredClone(config);
  transformed.tables[0] = {
    source: "public.orders",
    target: "RAW.ORDERS",
    primaryKey: ["id"],
    freshnessColumn: "updated_at",
    columnComparisons: [
      { source: "id", target: "order_id" },
      { source: "status_code", target: "status", normalize: "uppercase-trim", valueMap: { P: "PAID" } },
      { source: "updated_at", target: "source_updated_at" },
    ],
    targetApplyTimestampColumn: "_SNOWFLAKE_UPDATED_AT",
  };
  const postgres = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "17.1" }],
    [
      { column_name: "id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "status_code", data_type: "text", is_nullable: "NO" },
      { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ],
    [{ row_count: "1", distinct_primary_keys: "1", max_freshness: "2026-01-01T00:09:50Z" }],
    [{ bucket_id: "a1", row_count: "1", key_checksum: "keys", content_checksum: "content" }],
  ]);
  const snowflake = new FakeClient([
    [{ database_time: "2026-01-01T00:20:00Z", session_timezone: "UTC", database_version: "9.0" }],
    [
      { column_name: "ORDER_ID", data_type: "NUMBER", is_nullable: "NO" },
      { column_name: "STATUS", data_type: "VARCHAR", is_nullable: "NO" },
      { column_name: "SOURCE_UPDATED_AT", data_type: "TIMESTAMP_TZ", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_UPDATED_AT", data_type: "TIMESTAMP_TZ", is_nullable: "NO" },
    ],
    [{ row_count: 1, distinct_primary_keys: 1, max_freshness: "2026-01-01T00:09:50Z", min_delivery_lag_seconds: 5, p95_delivery_lag_seconds: 5, max_delivery_lag_seconds: 5, delivery_lag_row_count: 1, missing_delivery_timestamp_count: 0 }],
    [{ bucket_id: "a1", row_count: 1, key_checksum: "keys", content_checksum: "content" }],
  ]);
  await collectSnapshot(transformed, { postgres, snowflake }, { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" }, {});
  assert.match(postgres.calls[3].sql, /CASE status_code::text WHEN 'P' THEN 'PAID'/);
  assert.match(snowflake.calls[2].sql, /COUNT\(DISTINCT order_id\)/);
  assert.match(snowflake.calls[2].sql, /MAX\(source_updated_at\)/);
  assert.match(snowflake.calls[3].sql, /TO_VARCHAR\(order_id\)/i);
  assert.match(snowflake.calls[3].sql, /UPPER\(TRIM\(TO_VARCHAR\(status\)\)\)/i);
});
