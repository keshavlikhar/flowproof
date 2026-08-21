import test from "node:test";
import assert from "node:assert/strict";
import { audit } from "../src/audit.ts";
import type { Config, Snapshot } from "../src/types.ts";

const config: Config = {
  version: 1,
  pipeline: { name: "orders", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  replication: { postgresSlotName: "snowflake_connector_test", maxUnconfirmedWalBytes: 1000, maxRetainedWalBytes: 2000 },
  tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at", targetSoftDeleteColumn: "_SNOWFLAKE_DELETED", targetApplyTimestampColumn: "_SNOWFLAKE_UPDATED_AT" }],
};

function snapshot(): Snapshot {
  return {
    observedAt: "2026-01-01T00:02:00Z",
    source: { tables: { "public.orders": { name: "public.orders", columns: [{ name: "id", type: "bigint", nullable: false }], rowCount: 2, distinctPrimaryKeys: 2, maxFreshnessValue: "2026-01-01T00:01:00Z", checksumBuckets: [{ id: "a1", rowCount: 2, keyChecksum: "same-keys", contentChecksum: "same-content" }] } } },
    target: { tables: { "RAW.ORDERS": { name: "RAW.ORDERS", columns: [{ name: "id", type: "number", nullable: false }], rowCount: 2, distinctPrimaryKeys: 2, maxFreshnessValue: "2026-01-01T00:00:30Z", maxDeliveryLagSeconds: 30, checksumBuckets: [{ id: "a1", rowCount: 2, keyChecksum: "same-keys", contentChecksum: "same-content" }], activeRowFilter: "_SNOWFLAKE_DELETED = FALSE" } } },
    replication: { slotName: "snowflake_connector_test", found: true, active: true, restartLsn: "0/100", confirmedFlushLsn: "0/200", currentWalLsn: "0/220", unconfirmedWalBytes: 32, retainedWalBytes: 288, walStatus: "reserved" },
    cost: { projectedMonthlyUsd: 50, method: "test", confidence: "high" },
  };
}

test("passes when all dimensions have matching evidence", () => {
  const report = audit(config, snapshot());
  assert.equal(report.overall, "pass");
  assert.equal(report.results.length, 6);
  assert.ok(report.results.every((result) => result.status === "pass"));
});

test("fails duplicates, late delivery, and budget excess", () => {
  const input = snapshot();
  input.target.tables["RAW.ORDERS"].rowCount = 3;
  input.target.tables["RAW.ORDERS"].distinctPrimaryKeys = 2;
  input.target.tables["RAW.ORDERS"].maxDeliveryLagSeconds = 3600;
  input.target.tables["RAW.ORDERS"].checksumBuckets![0] = { id: "a1", rowCount: 3, keyChecksum: "different-keys", contentChecksum: "different-content" };
  input.cost!.projectedMonthlyUsd = 150;
  const report = audit(config, input);
  assert.equal(report.overall, "fail");
  assert.equal(report.results.find((result) => result.dimension === "exactly-once")?.status, "fail");
  assert.equal(report.results.find((result) => result.dimension === "timeliness")?.status, "fail");
  assert.equal(report.results.find((result) => result.dimension === "cost")?.status, "fail");
});

test("returns unknown rather than claiming proof when checksums are absent", () => {
  const input = snapshot();
  delete input.source.tables["public.orders"].checksumBuckets;
  delete input.target.tables["RAW.ORDERS"].checksumBuckets;
  const report = audit(config, input);
  assert.equal(report.overall, "unknown");
  assert.equal(report.results.find((result) => result.dimension === "correctness")?.status, "unknown");
  assert.equal(report.results.find((result) => result.dimension === "exactly-once")?.status, "unknown");
});

test("detects different keys even when row and distinct-key counts match", () => {
  const input = snapshot();
  input.target.tables["RAW.ORDERS"].checksumBuckets![0].keyChecksum = "same-count-different-keys";
  const report = audit(config, input);
  assert.equal(report.results.find((result) => result.dimension === "exactly-once")?.status, "fail");
});

test("rejects checksum evidence that does not cover every counted row", () => {
  const input = snapshot();
  input.target.tables["RAW.ORDERS"].checksumBuckets![0].rowCount = 1;
  const report = audit(config, input);
  assert.equal(report.results.find((result) => result.dimension === "correctness")?.status, "fail");
  assert.equal(report.results.find((result) => result.dimension === "exactly-once")?.status, "fail");
});

test("fails an inactive or dangerously lagging replication slot", () => {
  const input = snapshot();
  input.replication!.active = false;
  input.replication!.retainedWalBytes = 5000;
  const report = audit(config, input);
  assert.equal(report.results.find((result) => result.dimension === "capture")?.status, "fail");
});

test("does not pass a low-confidence partial cost estimate", () => {
  const input = snapshot();
  input.cost!.confidence = "low";
  const report = audit(config, input);
  assert.equal(report.overall, "unknown");
  assert.equal(report.results.find((result) => result.dimension === "cost")?.status, "unknown");
});
