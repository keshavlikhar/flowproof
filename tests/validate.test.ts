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

test("refuses to present the native relay as a production connector", () => {
  assert.throws(() => validateConfig({
    version: 2,
    pipeline: { name: "orders", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    relay: { testOnly: false, postgresSlotName: "slot", postgresPublicationName: "publication", snowflakeLedgerTable: "RAW.LEDGER" },
    tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
  }), /testOnly must be true/);
});

test("requires a journal table for the simulated Openflow workflow", () => {
  assert.throws(() => validateConfig({
    version: 2,
    pipeline: { name: "orders", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    relay: { testOnly: true, workflow: "openflow-simulated", postgresSlotName: "slot", postgresPublicationName: "publication", snowflakeLedgerTable: "RAW.LEDGER" },
    tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
  }), /snowflakeJournalTable is required/);
});

test("accepts bounded deterministic transformation rules", () => {
  assert.doesNotThrow(() => validateConfig({
    version: 2,
    pipeline: { name: "orders", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    reconciliation: { maxMismatchBuckets: 5, maxMismatchRowsPerBucket: 1000 },
    tables: [{
      source: "public.orders",
      target: "RAW.ORDERS",
      primaryKey: ["id"],
      targetPrimaryKey: ["order_id"],
      freshnessColumn: "updated_at",
      targetFreshnessColumn: "source_updated_at",
      columnComparisons: [{ source: "status_code", target: "status", normalize: "uppercase-trim", valueMap: { P: "PAID" } }],
    }],
  }));
});

test("rejects arbitrary or ambiguous transformation configuration", () => {
  const base = {
    version: 2,
    pipeline: { name: "orders", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    tables: [{
      source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at",
      checksumColumns: ["id"], columnComparisons: [{ source: "id", normalize: "run-sql" }],
    }],
  };
  assert.throws(() => validateConfig(base), /cannot combine checksumColumns and columnComparisons/);
  delete (base.tables[0] as { checksumColumns?: string[] }).checksumColumns;
  assert.throws(() => validateConfig(base), /normalize is unsupported/);
});

test("does not imply that the test relay executes transformation contracts", () => {
  assert.throws(() => validateConfig({
    version: 2,
    pipeline: { name: "orders", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    relay: { testOnly: true, postgresSlotName: "slot", postgresPublicationName: "publication", snowflakeLedgerTable: "RAW.LEDGER" },
    tables: [{
      source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at",
      columnComparisons: [{ source: "status_code", target: "status" }],
    }],
  }), /verifier-only/);
});
