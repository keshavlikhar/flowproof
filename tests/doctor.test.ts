import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/doctor.ts";
import type { QueryClient } from "../src/clients.ts";
import type { Config } from "../src/types.ts";

class FakeClient implements QueryClient {
  private readonly response: Record<string, unknown>;
  constructor(response: Record<string, unknown>) { this.response = response; }
  async query(sql: string) { return { rows: /CURRENT_ACCOUNT/.test(sql) || /current_database/.test(sql) ? [this.response] : [] }; }
  async close() {}
}

test("doctor checks connections and mapped tables without reading rows", async () => {
  const config: Config = {
    version: 2,
    pipeline: { name: "pilot", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
    tables: [{ source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at" }],
  };
  const postgres = new FakeClient({ database_name: "pilot", user_name: "reader", session_timezone: "UTC", wal_level: "logical", database_version: "17" });
  const snowflake = new FakeClient({ account_name: "trial", user_name: "reader", role_name: "FLOWPROOF_READER", warehouse_name: "WH", database_version: "9" });
  const results = await diagnose(config, { postgres, snowflake });
  assert.equal(results.filter((result) => result.status === "fail").length, 0);
  assert.equal(results.find((result) => result.name === "Replication capture")?.status, "warn");
});
