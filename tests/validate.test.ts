import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, validateSnapshot } from "../src/validate.ts";

test("rejects a configuration without table mappings", () => {
  assert.throws(() => validateConfig({
    version: 1,
    pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    tables: [],
  }), /at least one mapping/);
});

test("rejects a malformed snapshot timestamp", () => {
  assert.throws(() => validateSnapshot({ observedAt: "yesterday", source: { tables: {} }, target: { tables: {} } }), /ISO-8601/);
});

test("validates replication-slot limits", () => {
  assert.throws(() => validateConfig({
    version: 1,
    pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    replication: { postgresSlotName: "slot", maxUnconfirmedWalBytes: -1, maxRetainedWalBytes: 1000 },
    tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
  }), /maxUnconfirmedWalBytes/);
});

test("rejects overlapping custom policy dimensions", () => {
  assert.throws(() => validateConfig({
    version: 2,
    pipeline: {
      name: "orders",
      policy: { required: ["correctness"], optional: ["correctness"] },
      rowCountTolerancePercent: 0,
      maxLagSeconds: 60,
      monthlyCostBudgetUsd: 100,
    },
    tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
  }), /both required and optional/);
});
