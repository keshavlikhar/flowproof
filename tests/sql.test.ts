import test from "node:test";
import assert from "node:assert/strict";
import { queryPlan } from "../src/sql.ts";
import type { Config } from "../src/types.ts";

const config: Config = {
  version: 1,
  pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  replication: { postgresSlotName: "snowflake_connector_test", maxUnconfirmedWalBytes: 1000, maxRetainedWalBytes: 2000 },
  tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at", targetSoftDeleteColumn: "_SNOWFLAKE_DELETED", targetApplyTimestampColumn: "_SNOWFLAKE_UPDATED_AT" }],
};

test("creates source and target evidence queries", () => {
  const plan = queryPlan(config);
  assert.match(plan, /PostgreSQL evidence/);
  assert.match(plan, /Snowflake evidence/);
  assert.match(plan, /COUNT\(DISTINCT/);
  assert.match(plan, /max_freshness/);
  assert.match(plan, /pg_replication_slots/);
  assert.match(plan, /COALESCE\(_SNOWFLAKE_DELETED, FALSE\) = FALSE/);
  assert.match(plan, /max_delivery_lag_seconds/);
  assert.match(plan, /p95_delivery_lag_seconds/);
  assert.doesNotMatch(plan, /GREATEST/);
});

test("rejects unsafe table identifiers", () => {
  const unsafe = structuredClone(config);
  unsafe.tables[0].source = "public.orders; DROP TABLE x";
  assert.throws(() => queryPlan(unsafe), /schema\.table/);
});

test("rejects unsafe column identifiers", () => {
  const unsafe = structuredClone(config);
  unsafe.tables[0].freshnessColumn = "updated_at); DROP TABLE x; --";
  assert.throws(() => queryPlan(unsafe), /Unsafe SQL identifier/);
});
