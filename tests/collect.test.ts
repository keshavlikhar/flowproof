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
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: new Date("2026-01-01T00:09:50Z") }],
    [{ bucket_id: "a1", row_count: "2", key_checksum: "keys", content_checksum: "content" }],
  ]);
  const snowflake = new FakeClient([
    [
      { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", IS_NULLABLE: "NO" },
      { COLUMN_NAME: "_SNOWFLAKE_DELETED", DATA_TYPE: "BOOLEAN", IS_NULLABLE: "NO" },
      { COLUMN_NAME: "_SNOWFLAKE_UPDATED_AT", DATA_TYPE: "TIMESTAMP_NTZ", IS_NULLABLE: "NO" },
    ],
    [{ ROW_COUNT: 2, DISTINCT_PRIMARY_KEYS: 2, MAX_FRESHNESS: "2026-01-01T00:09:30Z", MAX_DELIVERY_LAG_SECONDS: 20 }],
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
  assert.deepEqual(snapshot.window, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T00:10:00.000Z" });
  assert.match(postgres.calls[1].sql, /WHERE updated_at >= \$1/);
  assert.match(snowflake.calls[1].sql, /WHERE updated_at >= TO_TIMESTAMP_TZ\(\?\)/);
  assert.match(snowflake.calls[1].sql, /COALESCE\(_SNOWFLAKE_DELETED, FALSE\) = FALSE/);
  assert.match(snowflake.calls[1].sql, /DATEDIFF\('second', updated_at, _SNOWFLAKE_UPDATED_AT\)/);
  assert.match(postgres.calls[2].sql, /STRING_AGG/);
  assert.match(snowflake.calls[2].sql, /LISTAGG/);
  assert.deepEqual(postgres.calls[1].binds, ["2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z"]);
  assert.equal(snapshot.cost, undefined);
});

test("collects PostgreSQL logical replication-slot progress", async () => {
  const withReplication = structuredClone(config);
  withReplication.replication = { postgresSlotName: "snowflake_connector_test", maxUnconfirmedWalBytes: 1000, maxRetainedWalBytes: 2000 };
  const postgres = new FakeClient([
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: "2026-01-01T00:09:50Z" }],
    [{ bucket_id: "a1", row_count: "2", key_checksum: "keys", content_checksum: "content" }],
    [{ slot_name: "snowflake_connector_test", active: true, restart_lsn: "0/100", confirmed_flush_lsn: "0/200", current_wal_lsn: "0/220", unconfirmed_wal_bytes: "32", retained_wal_bytes: "288", wal_status: "reserved", invalidation_reason: null }],
  ]);
  const snowflake = new FakeClient([
    [
      { column_name: "ID", data_type: "NUMBER", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_DELETED", data_type: "BOOLEAN", is_nullable: "NO" },
      { column_name: "_SNOWFLAKE_UPDATED_AT", data_type: "TIMESTAMP_NTZ", is_nullable: "NO" },
    ],
    [{ row_count: 2, distinct_primary_keys: 2, max_freshness: "2026-01-01T00:09:30Z", max_delivery_lag_seconds: 20 }],
    [{ bucket_id: "a1", row_count: 2, key_checksum: "keys", content_checksum: "content" }],
  ]);
  const snapshot = await collectSnapshot(withReplication, { postgres, snowflake }, { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" }, {});
  assert.equal(snapshot.replication?.confirmedFlushLsn, "0/200");
  assert.equal(snapshot.replication?.unconfirmedWalBytes, 32);
  assert.match(postgres.calls[3].sql, /pg_replication_slots/);
  assert.deepEqual(postgres.calls[3].binds, ["snowflake_connector_test"]);
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
