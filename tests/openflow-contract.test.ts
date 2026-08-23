import test from "node:test";
import assert from "node:assert/strict";
import { openflowContract, renderOpenflowContract } from "../src/openflow-contract.ts";
import type { Config } from "../src/types.ts";

const config: Config = {
  version: 2,
  pipeline: { name: "pilot", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  relay: { testOnly: true, workflow: "openflow-simulated", postgresSlotName: "slot", postgresPublicationName: "publication", snowflakeLedgerTable: "RAW.LEDGER", snowflakeJournalTable: "RAW.SIM_JOURNAL" },
  tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
};

test("contract report stays partial and labels the actual Openflow runtime unverified", () => {
  const report = openflowContract(config);
  assert.equal(report.conclusion, "partial");
  assert.match(report.disclaimer, /has not executed or certified/);
  assert.equal(report.items.find((item) => item.capability.startsWith("Actual Openflow runtime"))?.status, "unverified");
  assert.match(renderOpenflowContract(report), /PARTIAL/);
});
