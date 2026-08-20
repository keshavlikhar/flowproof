import test from "node:test";
import assert from "node:assert/strict";
import { queryPlan } from "../src/sql.ts";
import type { Config } from "../src/types.ts";

const config: Config = {
  version: 1,
  pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
};

test("creates source and target evidence queries", () => {
  const plan = queryPlan(config);
  assert.match(plan, /PostgreSQL evidence/);
  assert.match(plan, /Snowflake evidence/);
  assert.match(plan, /COUNT\(DISTINCT/);
  assert.match(plan, /max_freshness/);
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
