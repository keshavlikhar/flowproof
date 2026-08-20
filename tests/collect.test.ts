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
  tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
};

test("collects bounded metadata and metrics without retrieving source rows", async () => {
  const postgres = new FakeClient([
    [{ column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    [{ row_count: "2", distinct_primary_keys: "2", max_freshness: new Date("2026-01-01T00:09:50Z") }],
  ]);
  const snowflake = new FakeClient([
    [{ COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", IS_NULLABLE: "NO" }],
    [{ ROW_COUNT: 2, DISTINCT_PRIMARY_KEYS: 2, MAX_FRESHNESS: "2026-01-01T00:09:30Z" }],
  ]);
  const snapshot = await collectSnapshot(
    config,
    { postgres, snowflake },
    { since: "2026-01-01T00:00:00Z", until: "2026-01-01T00:10:00Z" },
    {},
  );
  assert.equal(snapshot.source.tables["public.orders"].rowCount, 2);
  assert.equal(snapshot.target.tables["RAW.ORDERS"].distinctPrimaryKeys, 2);
  assert.deepEqual(snapshot.window, { since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T00:10:00.000Z" });
  assert.match(postgres.calls[1].sql, /WHERE updated_at >= \$1/);
  assert.match(snowflake.calls[1].sql, /WHERE updated_at >= TO_TIMESTAMP_TZ\(\?\)/);
  assert.deepEqual(postgres.calls[1].binds, ["2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z"]);
  assert.equal(snapshot.cost, undefined);
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
