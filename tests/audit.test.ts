import test from "node:test";
import assert from "node:assert/strict";
import { audit } from "../src/audit.ts";
import type { Config, Snapshot } from "../src/types.ts";

const config: Config = {
  version: 1,
  pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
};

function snapshot(): Snapshot {
  return {
    observedAt: "2026-01-01T00:02:00Z",
    source: { tables: { "public.orders": { name: "public.orders", columns: [{ name: "id", type: "bigint", nullable: false }], rowCount: 2, maxFreshnessValue: "2026-01-01T00:01:00Z", checksum: "same" } } },
    target: { tables: { "RAW.ORDERS": { name: "RAW.ORDERS", columns: [{ name: "id", type: "number", nullable: false }], rowCount: 2, distinctPrimaryKeys: 2, maxFreshnessValue: "2026-01-01T00:00:30Z", checksum: "same" } } },
    cost: { projectedMonthlyUsd: 50, method: "test", confidence: "high" },
  };
}

test("passes when all five dimensions have matching evidence", () => {
  const report = audit(config, snapshot());
  assert.equal(report.overall, "pass");
  assert.equal(report.results.length, 5);
  assert.ok(report.results.every((result) => result.status === "pass"));
});

test("fails duplicates, late delivery, and budget excess", () => {
  const input = snapshot();
  input.target.tables["RAW.ORDERS"].rowCount = 3;
  input.target.tables["RAW.ORDERS"].distinctPrimaryKeys = 2;
  input.target.tables["RAW.ORDERS"].maxFreshnessValue = "2025-12-31T23:00:00Z";
  input.target.tables["RAW.ORDERS"].checksum = "different";
  input.cost!.projectedMonthlyUsd = 150;
  const report = audit(config, input);
  assert.equal(report.overall, "fail");
  assert.equal(report.results.find((result) => result.dimension === "exactly-once")?.status, "fail");
  assert.equal(report.results.find((result) => result.dimension === "timeliness")?.status, "fail");
  assert.equal(report.results.find((result) => result.dimension === "cost")?.status, "fail");
});

test("returns unknown rather than claiming proof when checksums are absent", () => {
  const input = snapshot();
  delete input.source.tables["public.orders"].checksum;
  delete input.target.tables["RAW.ORDERS"].checksum;
  const report = audit(config, input);
  assert.equal(report.overall, "unknown");
  assert.equal(report.results.find((result) => result.dimension === "correctness")?.status, "unknown");
});
