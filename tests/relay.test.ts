import test from "node:test";
import assert from "node:assert/strict";
import { applyRelayTransaction, type RelayChange } from "../src/relay.ts";
import type { QueryClient } from "../src/clients.ts";
import type { Config } from "../src/types.ts";

class TransactionalFake implements QueryClient {
  readonly calls: { sql: string; binds: unknown[] }[] = [];
  ledgerCommitted = false;
  private ledgerPending = false;
  async query(sql: string, binds: unknown[] = []) {
    this.calls.push({ sql, binds });
    if (/SELECT COUNT\(\*\) AS transaction_count/.test(sql)) return { rows: [{ transaction_count: this.ledgerCommitted ? 1 : 0 }] };
    if (/INSERT INTO RAW\.FLOWPROOF_RELAY_TRANSACTIONS/.test(sql)) this.ledgerPending = true;
    if (sql === "COMMIT") {
      if (this.ledgerPending) this.ledgerCommitted = true;
      this.ledgerPending = false;
    }
    if (sql === "ROLLBACK") this.ledgerPending = false;
    return { rows: [] };
  }
  async close() {}
}

const config: Config = {
  version: 2,
  pipeline: { name: "relay", policy: "pilot", rowCountTolerancePercent: 0, maxLagSeconds: 60, monthlyCostBudgetUsd: 100 },
  relay: { testOnly: true, postgresSlotName: "flowproof_test_relay", postgresPublicationName: "flowproof_publication", snowflakeLedgerTable: "RAW.FLOWPROOF_RELAY_TRANSACTIONS" },
  tables: [{
    source: "public.orders", target: "RAW.ORDERS", primaryKey: ["id"], freshnessColumn: "updated_at",
    targetSoftDeleteColumn: "_SNOWFLAKE_DELETED", targetApplyTimestampColumn: "_SNOWFLAKE_UPDATED_AT",
  }],
};

function relation() {
  return { schema: "public", name: "orders" } as RelayChange["relation"];
}

const insert = { tag: "insert", relation: relation(), new: { id: "6", status: "paid", amount: "12.00", updated_at: "2026-08-23T00:00:00Z" } } as RelayChange;

test("commits target changes and transaction ledger atomically", async () => {
  const client = new TransactionalFake();
  const outcome = await applyRelayTransaction(client, config, { xid: 42, commitLsn: "0/ABC", changes: [insert] });
  assert.equal(outcome, "applied");
  assert.equal(client.ledgerCommitted, true);
  assert.match(client.calls.find((call) => /MERGE INTO/.test(call.sql))?.sql ?? "", /_SNOWFLAKE_UPDATED_AT = CURRENT_TIMESTAMP/);
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
});

test("replay after commit skips an already-ledgered transaction", async () => {
  const client = new TransactionalFake();
  const transaction = { xid: 42, commitLsn: "0/ABC", changes: [insert] };
  await assert.rejects(applyRelayTransaction(client, config, transaction, "after-snowflake-commit"), /after Snowflake commit/);
  assert.equal(client.ledgerCommitted, true);
  const mergeCount = client.calls.filter((call) => /MERGE INTO/.test(call.sql)).length;
  assert.equal(await applyRelayTransaction(client, config, transaction), "skipped");
  assert.equal(client.calls.filter((call) => /MERGE INTO/.test(call.sql)).length, mergeCount);
});

test("failure before commit rolls back and remains replayable", async () => {
  const client = new TransactionalFake();
  const transaction = { xid: 43, commitLsn: "0/DEF", changes: [insert] };
  await assert.rejects(applyRelayTransaction(client, config, transaction, "before-snowflake-commit"), /before Snowflake commit/);
  assert.equal(client.ledgerCommitted, false);
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(await applyRelayTransaction(client, config, transaction), "applied");
});

test("delete events become Openflow-shaped soft deletes", async () => {
  const client = new TransactionalFake();
  const deletion = { tag: "delete", relation: relation(), key: { id: "6" }, old: null } as RelayChange;
  await applyRelayTransaction(client, config, { xid: 44, commitLsn: "0/F00", changes: [deletion] });
  const update = client.calls.find((call) => /UPDATE RAW\.ORDERS SET/.test(call.sql));
  assert.match(update?.sql ?? "", /_SNOWFLAKE_DELETED = TRUE/);
  assert.deepEqual(update?.binds, ["6"]);
});
