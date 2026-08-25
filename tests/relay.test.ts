import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyRelayTransaction, assessRelayBarrier, configureLosslessPgoutputTypes, lsnToBytes, mergeRelayJournal, renderRelayBarrier, type RelayChange } from "../src/relay.ts";
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
    targetSoftDeleteColumn: "_SNOWFLAKE_DELETED", targetInsertTimestampColumn: "_SNOWFLAKE_INSERTED_AT", targetApplyTimestampColumn: "_SNOWFLAKE_UPDATED_AT",
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
  assert.match(client.calls.find((call) => /MERGE INTO/.test(call.sql))?.sql ?? "", /_SNOWFLAKE_INSERTED_AT/);
  const ledgerInsert = client.calls.find((call) => /INSERT INTO RAW\.FLOWPROOF_RELAY_TRANSACTIONS/.test(call.sql));
  assert.equal(ledgerInsert?.binds[3], lsnToBytes("0/ABC").toString());
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
});

const simulatedConfig: Config = {
  ...config,
  relay: {
    ...config.relay!,
    workflow: "openflow-simulated",
    snowflakeJournalTable: "RAW.FLOWPROOF_OPENFLOW_SIM_JOURNAL",
  },
};

class SimulatedFake implements QueryClient {
  readonly calls: { sql: string; binds: unknown[] }[] = [];
  pending = true;
  readonly events: Record<string, unknown>[];
  constructor(events: Record<string, unknown>[] = [{ source_schema: "public", source_table: "orders", operation: "insert", primary_keys: { id: "7" }, payload: { id: "7", status: "paid", amount: "8.00", updated_at: "2026-08-23T00:00:00Z" }, old_values: null }]) {
    this.events = events;
  }
  async query(sql: string, binds: unknown[] = []) {
    this.calls.push({ sql, binds });
    if (/SELECT COUNT\(\*\) AS transaction_count/.test(sql)) return { rows: [{ transaction_count: 0 }] };
    if (/SELECT transaction_id, source_xid, commit_lsn/.test(sql)) {
      return { rows: this.pending ? [{ transaction_id: "flowproof_test_relay:50:0/B00", source_xid: 50, commit_lsn: "0/B00" }] : [] };
    }
    if (/SELECT source_schema, source_table, operation/.test(sql)) {
      return { rows: this.events };
    }
    if (/UPDATE RAW\.FLOWPROOF_RELAY_TRANSACTIONS SET merged_at/.test(sql)) this.pending = false;
    return { rows: [] };
  }
  async close() {}
}

test("simulated Openflow capture commits a journal before destination merge", async () => {
  const client = new SimulatedFake();
  const outcome = await applyRelayTransaction(client, simulatedConfig, { xid: 50, commitLsn: "0/B00", changes: [insert] });
  assert.equal(outcome, "journaled");
  assert.equal(client.calls.filter((call) => /INSERT INTO RAW\.FLOWPROOF_OPENFLOW_SIM_JOURNAL/.test(call.sql)).length, 1);
  assert.equal(client.calls.filter((call) => /MERGE INTO RAW\.ORDERS/.test(call.sql)).length, 0);
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
});

test("pgoutput preserves PostgreSQL temporal microseconds as exact text", () => {
  configureLosslessPgoutputTypes();
  const value = "2026-08-24 04:29:23.928577+00";
  assert.equal(pg.types.getTypeParser(1184, "text")(value), value);
  assert.equal(pg.types.getTypeParser(1114, "text")("2026-08-24 04:29:23.123456"), "2026-08-24 04:29:23.123456");
});

test("converts PostgreSQL LSNs into monotonically comparable WAL offsets", () => {
  assert.equal(lsnToBytes("0/019742A0"), 26_690_208n);
  assert.ok(lsnToBytes("1/00000000") > lsnToBytes("0/FFFFFFFF"));
  assert.throws(() => lsnToBytes("not-an-lsn"), /Invalid PostgreSQL LSN/);
});

test("barrier output refuses deletion reconciliation while a transaction is pending", () => {
  const output = renderRelayBarrier(assessRelayBarrier("0/019742A0", "0/019742A0", 1, 1, "26690208"));
  assert.match(output, /FAIL/);
  assert.match(output, /Do not treat deletion reconciliation as complete/);
});

test("barrier passes only with acknowledgement, exact ledger evidence, and all prior merges", () => {
  assert.equal(assessRelayBarrier("0/019742A0", "0/019742A0", 1, 0, "26690208").status, "pass");
  assert.equal(assessRelayBarrier("0/019742A0", "0/0197429F", 1, 0, "26690208").status, "fail");
  assert.equal(assessRelayBarrier("0/019742A0", "0/019742A0", 0, 0, "26690208").status, "fail");
  assert.equal(assessRelayBarrier("0/019742A0", "0/019742A0", 1, 0, "26690207").status, "fail");
});

test("simulated journal and destination binds retain timestamp microseconds", async () => {
  const timestamp = "2026-08-24 04:29:23.928577+00";
  const capture = new SimulatedFake();
  const preciseInsert = {
    tag: "insert",
    relation: relation(),
    new: { id: "6", status: "paid", amount: "12.00", updated_at: timestamp },
  } as RelayChange;
  await applyRelayTransaction(capture, simulatedConfig, { xid: 51, commitLsn: "0/B01", changes: [preciseInsert] });
  const journalInsert = capture.calls.find((call) => /INSERT INTO RAW\.FLOWPROOF_OPENFLOW_SIM_JOURNAL/.test(call.sql));
  assert.match(String(journalInsert?.binds[7]), /04:29:23\.928577/);

  const merge = new SimulatedFake([{
    source_schema: "public", source_table: "orders", operation: "insert", primary_keys: { id: "6" },
    payload: { id: "6", status: "paid", amount: "12.00", updated_at: timestamp }, old_values: null,
  }]);
  await mergeRelayJournal(merge, simulatedConfig, 1);
  const targetMerge = merge.calls.find((call) => /MERGE INTO RAW\.ORDERS/.test(call.sql));
  assert.equal(targetMerge?.binds.at(-1), timestamp);
});

test("simulated Openflow merge applies journal rows and marks the ledger atomically", async () => {
  const client = new SimulatedFake();
  assert.equal(await mergeRelayJournal(client, simulatedConfig, 1), 1);
  assert.equal(client.calls.filter((call) => /MERGE INTO RAW\.ORDERS/.test(call.sql)).length, 1);
  assert.equal(client.pending, false);
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
});

test("simulated merge failure rolls back before commit", async () => {
  const client = new SimulatedFake();
  await assert.rejects(mergeRelayJournal(client, simulatedConfig, 1, "before-merge-commit"), /before simulated Openflow merge commit/);
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
});

test("simulated merge reconstructs updates and soft deletes from journal JSON", async () => {
  const client = new SimulatedFake([
    { source_schema: "public", source_table: "orders", operation: "update", primary_keys: JSON.stringify({ id: "7" }), payload: JSON.stringify({ id: "7", status: "shipped", amount: "8.00", updated_at: "2026-08-23T00:01:00Z" }), old_values: JSON.stringify({ id: "7" }) },
    { source_schema: "public", source_table: "orders", operation: "delete", primary_keys: JSON.stringify({ id: "8" }), payload: null, old_values: null },
  ]);
  assert.equal(await mergeRelayJournal(client, simulatedConfig, 1), 1);
  assert.equal(client.calls.filter((call) => /MERGE INTO RAW\.ORDERS/.test(call.sql)).length, 1);
  assert.equal(client.calls.filter((call) => /UPDATE RAW\.ORDERS SET _SNOWFLAKE_DELETED = TRUE/.test(call.sql)).length, 1);
});

test("lost response after merge commit does not reapply the transaction", async () => {
  const client = new SimulatedFake();
  await assert.rejects(mergeRelayJournal(client, simulatedConfig, 1, "after-merge-commit"), /after simulated Openflow merge commit/);
  const targetMerges = client.calls.filter((call) => /MERGE INTO RAW\.ORDERS/.test(call.sql)).length;
  assert.equal(await mergeRelayJournal(client, simulatedConfig, 1), 0);
  assert.equal(client.calls.filter((call) => /MERGE INTO RAW\.ORDERS/.test(call.sql)).length, targetMerges);
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
