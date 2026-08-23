import pg from "pg";
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from "pg-logical-replication";
import { snowflakeClient, type QueryClient } from "./clients.ts";
import type { Config, TableMapping } from "./types.ts";

export type RelayFailurePoint = "before-snowflake-commit" | "after-snowflake-commit";

export type RelayChange = Extract<Pgoutput.Message, { tag: "insert" | "update" | "delete" }>;

export interface RelayTransaction {
  xid: number;
  commitLsn: string;
  changes: RelayChange[];
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function qualifiedTable(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error(`Table must be schema.table: ${value}`);
  return `${identifier(parts[0])}.${identifier(parts[1])}`;
}

function field(row: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? row[key] : undefined;
}

function mappingFor(config: Config, change: RelayChange): TableMapping | undefined {
  const source = `${change.relation.schema}.${change.relation.name}`.toLowerCase();
  return config.tables.find((mapping) => mapping.source.toLowerCase() === source);
}

function relaySnowflakeClient(environment: NodeJS.ProcessEnv): QueryClient {
  const relayPrivateKeyPath = environment.FLOWPROOF_RELAY_SNOWFLAKE_PRIVATE_KEY_PATH;
  const relayPassword = environment.FLOWPROOF_RELAY_SNOWFLAKE_PASSWORD;
  if (!relayPrivateKeyPath && !relayPassword) {
    throw new Error("Set FLOWPROOF_RELAY_SNOWFLAKE_PRIVATE_KEY_PATH or FLOWPROOF_RELAY_SNOWFLAKE_PASSWORD");
  }
  return snowflakeClient({
    ...environment,
    FLOWPROOF_SNOWFLAKE_ACCOUNT: required(environment, "FLOWPROOF_RELAY_SNOWFLAKE_ACCOUNT"),
    FLOWPROOF_SNOWFLAKE_USER: required(environment, "FLOWPROOF_RELAY_SNOWFLAKE_USER"),
    FLOWPROOF_SNOWFLAKE_PASSWORD: relayPassword,
    FLOWPROOF_SNOWFLAKE_PRIVATE_KEY_PATH: relayPrivateKeyPath,
    FLOWPROOF_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: environment.FLOWPROOF_RELAY_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
    FLOWPROOF_SNOWFLAKE_WAREHOUSE: required(environment, "FLOWPROOF_RELAY_SNOWFLAKE_WAREHOUSE"),
    FLOWPROOF_SNOWFLAKE_DATABASE: required(environment, "FLOWPROOF_RELAY_SNOWFLAKE_DATABASE"),
    FLOWPROOF_SNOWFLAKE_SCHEMA: required(environment, "FLOWPROOF_RELAY_SNOWFLAKE_SCHEMA"),
    FLOWPROOF_SNOWFLAKE_ROLE: required(environment, "FLOWPROOF_RELAY_SNOWFLAKE_ROLE"),
  });
}

function keyPredicate(mapping: TableMapping, row: Record<string, unknown>): { sql: string; binds: unknown[] } {
  const binds: unknown[] = [];
  const byLower = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  const sql = mapping.primaryKey.map((key) => {
    const name = identifier(key);
    const actual = byLower.get(key.toLowerCase());
    if (!actual) throw new Error(`CDC event for ${mapping.source} is missing primary-key column ${key}`);
    binds.push(row[actual]);
    return `${name} = ?`;
  }).join(" AND ");
  return { sql, binds };
}

async function softDelete(client: QueryClient, mapping: TableMapping, row: Record<string, unknown>): Promise<void> {
  const target = qualifiedTable(mapping.target);
  const key = keyPredicate(mapping, row);
  if (mapping.targetSoftDeleteColumn) {
    const deleted = identifier(mapping.targetSoftDeleteColumn);
    const apply = mapping.targetApplyTimestampColumn ? `, ${identifier(mapping.targetApplyTimestampColumn)} = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ` : "";
    await client.query(`UPDATE ${target} SET ${deleted} = TRUE${apply} WHERE ${key.sql}`, key.binds);
  } else {
    await client.query(`DELETE FROM ${target} WHERE ${key.sql}`, key.binds);
  }
}

function changedPrimaryKey(mapping: TableMapping, previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const previousByLower = new Map(Object.keys(previous).map((key) => [key.toLowerCase(), previous[key]]));
  const nextByLower = new Map(Object.keys(next).map((key) => [key.toLowerCase(), next[key]]));
  return mapping.primaryKey.some((key) => String(previousByLower.get(key.toLowerCase())) !== String(nextByLower.get(key.toLowerCase())));
}

async function upsert(client: QueryClient, mapping: TableMapping, row: Record<string, unknown>): Promise<void> {
  const target = qualifiedTable(mapping.target);
  const columns = Object.keys(row).map(identifier);
  if (!columns.length) throw new Error(`CDC event for ${mapping.source} contains no columns`);
  const byLower = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  const sourceKey = (key: string) => {
    const actual = byLower.get(key.toLowerCase());
    if (!actual) throw new Error(`CDC event for ${mapping.source} is missing primary-key column ${key}`);
    return identifier(actual);
  };
  const source = `SELECT ${columns.map((column) => `? AS ${column}`).join(", ")}`;
  const on = mapping.primaryKey.map((key) => {
    const column = sourceKey(key);
    return `target.${column} = source.${column}`;
  }).join(" AND ");
  const updates = columns.filter((column) => !mapping.primaryKey.some((key) => key.toLowerCase() === column.toLowerCase()))
    .map((column) => `target.${column} = source.${column}`);
  const columnNames = new Set(columns.map((column) => column.toLowerCase()));
  if (mapping.targetSoftDeleteColumn && !columnNames.has(mapping.targetSoftDeleteColumn.toLowerCase())) updates.push(`target.${identifier(mapping.targetSoftDeleteColumn)} = FALSE`);
  if (mapping.targetApplyTimestampColumn && !columnNames.has(mapping.targetApplyTimestampColumn.toLowerCase())) updates.push(`target.${identifier(mapping.targetApplyTimestampColumn)} = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ`);
  if (!updates.length) {
    const firstKey = sourceKey(mapping.primaryKey[0]);
    updates.push(`target.${firstKey} = source.${firstKey}`);
  }
  const insertColumns = [...columns];
  const insertValues = columns.map((column) => `source.${column}`);
  if (mapping.targetSoftDeleteColumn && !columnNames.has(mapping.targetSoftDeleteColumn.toLowerCase())) {
    insertColumns.push(identifier(mapping.targetSoftDeleteColumn));
    insertValues.push("FALSE");
  }
  if (mapping.targetApplyTimestampColumn && !columnNames.has(mapping.targetApplyTimestampColumn.toLowerCase())) {
    insertColumns.push(identifier(mapping.targetApplyTimestampColumn));
    insertValues.push("CURRENT_TIMESTAMP()::TIMESTAMP_NTZ");
  }
  await client.query(
    `MERGE INTO ${target} AS target USING (${source}) AS source ON ${on}
WHEN MATCHED THEN UPDATE SET ${updates.join(", ")}
WHEN NOT MATCHED THEN INSERT (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
    columns.map((column) => row[column]),
  );
}

async function applyChange(client: QueryClient, config: Config, change: RelayChange): Promise<void> {
  const mapping = mappingFor(config, change);
  if (!mapping) return;
  if (change.tag === "delete") {
    const previous = change.key ?? change.old;
    if (!previous) throw new Error(`Delete event for ${mapping.source} has no replica identity`);
    await softDelete(client, mapping, previous);
    return;
  }
  if (change.tag === "update" && change.key && changedPrimaryKey(mapping, change.key, change.new)) {
    await softDelete(client, mapping, change.key);
  }
  await upsert(client, mapping, change.new);
}

export async function applyRelayTransaction(
  client: QueryClient,
  config: Config,
  transaction: RelayTransaction,
  failurePoint?: RelayFailurePoint,
): Promise<"applied" | "skipped"> {
  if (!config.relay) throw new Error("config.relay is required");
  const ledger = qualifiedTable(config.relay.snowflakeLedgerTable);
  const transactionId = `${config.relay.postgresSlotName}:${transaction.xid}:${transaction.commitLsn}`;
  await client.query("BEGIN TRANSACTION");
  let committed = false;
  try {
    const existing = await client.query(`SELECT COUNT(*) AS transaction_count FROM ${ledger} WHERE transaction_id = ?`, [transactionId]);
    if (Number(field(existing.rows[0] ?? {}, "transaction_count")) > 0) {
      await client.query("COMMIT");
      committed = true;
      return "skipped";
    }
    for (const change of transaction.changes) await applyChange(client, config, change);
    await client.query(
      `INSERT INTO ${ledger} (transaction_id, source_xid, commit_lsn, change_count, committed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP())`,
      [transactionId, transaction.xid, transaction.commitLsn, transaction.changes.length],
    );
    if (failurePoint === "before-snowflake-commit") throw new Error("Injected failure before Snowflake commit");
    await client.query("COMMIT");
    committed = true;
    if (failurePoint === "after-snowflake-commit") throw new Error("Injected failure after Snowflake commit and before PostgreSQL acknowledgement");
    return "applied";
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function setupRelay(config: Config, environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (!config.relay) throw new Error("config.relay is required");
  const postgres = new pg.Client({ connectionString: required(environment, "FLOWPROOF_RELAY_POSTGRES_URL"), application_name: "flowproof-test-relay-setup" });
  const snowflake = relaySnowflakeClient(environment);
  const messages: string[] = [];
  try {
    await postgres.connect();
    const ledger = qualifiedTable(config.relay.snowflakeLedgerTable);
    await snowflake.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
      transaction_id VARCHAR NOT NULL,
      source_xid NUMBER(38, 0) NOT NULL,
      commit_lsn VARCHAR NOT NULL,
      change_count NUMBER(38, 0) NOT NULL,
      committed_at TIMESTAMP_LTZ NOT NULL,
      PRIMARY KEY (transaction_id)
    )`);
    messages.push(`Snowflake ledger ${ledger} is ready`);
    const slots = await postgres.query("SELECT plugin FROM pg_replication_slots WHERE slot_name = $1", [config.relay.postgresSlotName]);
    if (slots.rows[0] && slots.rows[0].plugin !== "pgoutput") throw new Error(`Existing slot ${config.relay.postgresSlotName} does not use pgoutput`);
    if (!slots.rows[0]) {
      await postgres.query("SELECT * FROM pg_create_logical_replication_slot($1, 'pgoutput')", [config.relay.postgresSlotName]);
      messages.push(`created PostgreSQL slot ${config.relay.postgresSlotName}`);
    } else messages.push(`PostgreSQL slot ${config.relay.postgresSlotName} already exists`);
  } finally {
    await Promise.allSettled([postgres.end(), snowflake.close()]);
  }
  return messages;
}

export async function runRelay(
  config: Config,
  environment: NodeJS.ProcessEnv = process.env,
  maxTransactions?: number,
): Promise<number> {
  if (!config.relay) throw new Error("config.relay is required");
  const client = relaySnowflakeClient(environment);
  const service = new LogicalReplicationService(
    { connectionString: required(environment, "FLOWPROOF_RELAY_POSTGRES_URL"), application_name: "flowproof-test-relay" },
    { acknowledge: { auto: false, timeoutSeconds: 0 }, flowControl: { enabled: true } },
  );
  const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [config.relay.postgresPublicationName] });
  let current: { xid: number; changes: RelayChange[] } | undefined;
  let processed = 0;
  let lastSafeLsn: string | undefined;
  let fatal: Error | undefined;
  const failure = environment.FLOWPROOF_RELAY_FAILURE_POINT as RelayFailurePoint | undefined;
  if (failure && failure !== "before-snowflake-commit" && failure !== "after-snowflake-commit") {
    throw new Error("FLOWPROOF_RELAY_FAILURE_POINT must be before-snowflake-commit or after-snowflake-commit");
  }
  const stop = () => { void service.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  service.on("heartbeat", async (_lsn, _timestamp, shouldRespond) => {
    if (shouldRespond && lastSafeLsn) await service.acknowledge(lastSafeLsn, true);
  });
  service.on("data", async (lsn: string, message: Pgoutput.Message) => {
    if (message.tag === "begin") {
      if (current) throw new Error("Received nested PostgreSQL transaction");
      current = { xid: message.xid, changes: [] };
      return;
    }
    if (message.tag === "insert" || message.tag === "update" || message.tag === "delete") {
      if (!current) throw new Error(`Received ${message.tag} outside a PostgreSQL transaction`);
      if (mappingFor(config, message)) current.changes.push(message);
      return;
    }
    if (message.tag === "truncate") throw new Error("TRUNCATE is intentionally unsupported by the test relay");
    if (message.tag !== "commit") return;
    if (!current) throw new Error("Received PostgreSQL commit without begin");
    const commitLsn = message.commitEndLsn ?? message.commitLsn ?? lsn;
    const outcome = await applyRelayTransaction(client, config, { xid: current.xid, commitLsn, changes: current.changes }, failure);
    lastSafeLsn = commitLsn;
    await service.acknowledge(commitLsn);
    processed += 1;
    console.log(`Relay ${outcome}: xid=${current.xid} commit_lsn=${commitLsn} changes=${current.changes.length}`);
    current = undefined;
    if (maxTransactions !== undefined && processed >= maxTransactions) await service.stop();
  });
  service.on("error", async (error: Error) => {
    fatal ??= error;
    await service.stop().catch(() => undefined);
  });
  try {
    await service.subscribe(plugin, config.relay.postgresSlotName);
    if (fatal) throw fatal;
    return processed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled([service.destroy(), client.close()]);
  }
}
