import type { Config } from "./types.ts";
import type { LiveClients, QueryClient } from "./clients.ts";

export interface DoctorResult {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
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

async function attempt(name: string, action: () => Promise<string>): Promise<DoctorResult> {
  try {
    return { name, status: "pass", detail: await action() };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function postgresSystem(client: QueryClient, requireLogical: boolean): Promise<string> {
  const result = await client.query("SELECT current_database() AS database_name, current_user AS user_name, current_setting('TimeZone') AS session_timezone, current_setting('wal_level') AS wal_level, current_setting('server_version') AS database_version");
  const row = result.rows[0] ?? {};
  const timezone = String(field(row, "session_timezone"));
  if (timezone !== "UTC") throw new Error(`PostgreSQL session timezone is ${timezone}; expected UTC`);
  const walLevel = String(field(row, "wal_level"));
  if (requireLogical && walLevel !== "logical") throw new Error(`PostgreSQL wal_level is ${walLevel}; capture requires logical`);
  return `connected to ${String(field(row, "database_name"))} as ${String(field(row, "user_name"))}; PostgreSQL ${String(field(row, "database_version"))}; wal_level=${walLevel}; UTC`;
}

async function snowflakeSystem(client: QueryClient): Promise<string> {
  const result = await client.query("SELECT CURRENT_ACCOUNT() AS account_name, CURRENT_USER() AS user_name, CURRENT_ROLE() AS role_name, CURRENT_WAREHOUSE() AS warehouse_name, CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name, CURRENT_VERSION() AS database_version");
  const row = result.rows[0] ?? {};
  return `connected to ${String(field(row, "account_name"))} as ${String(field(row, "user_name"))}; role=${String(field(row, "role_name"))}; warehouse=${String(field(row, "warehouse_name"))}; Snowflake ${String(field(row, "database_version"))}`;
}

export async function diagnose(config: Config, clients: LiveClients): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  results.push(await attempt("PostgreSQL connection", () => postgresSystem(clients.postgres, Boolean(config.replication || config.relay))));
  results.push(await attempt("Snowflake connection", () => snowflakeSystem(clients.snowflake)));
  for (const mapping of config.tables) {
    results.push(await attempt(`PostgreSQL table ${mapping.source}`, async () => {
      await clients.postgres.query(`SELECT 1 FROM ${qualifiedTable(mapping.source)} WHERE FALSE`);
      return "readable";
    }));
    results.push(await attempt(`Snowflake table ${mapping.target}`, async () => {
      await clients.snowflake.query(`SELECT 1 FROM ${qualifiedTable(mapping.target)} WHERE 1 = 0`);
      return "readable";
    }));
  }
  if (config.replication) {
    results.push(await attempt(`Replication slot ${config.replication.postgresSlotName}`, async () => {
      const found = await clients.postgres.query("SELECT active, wal_status FROM pg_replication_slots WHERE slot_name = $1 AND slot_type = 'logical'", [config.replication!.postgresSlotName]);
      if (!found.rows[0]) throw new Error("logical replication slot was not found");
      return `found; active=${String(field(found.rows[0], "active"))}; wal_status=${String(field(found.rows[0], "wal_status"))}`;
    }));
  } else {
    results.push({ name: "Replication capture", status: "warn", detail: "not configured; capture health will remain UNKNOWN" });
  }
  results.push({
    name: "Cost attribution",
    status: process.env.FLOWPROOF_SNOWFLAKE_TASK_NAME && process.env.FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD ? "pass" : "warn",
    detail: process.env.FLOWPROOF_SNOWFLAKE_TASK_NAME && process.env.FLOWPROOF_SNOWFLAKE_CREDIT_RATE_USD
      ? "serverless task and credit rate configured"
      : "not configured; complete pipeline cost will remain UNKNOWN",
  });
  return results;
}

export function renderDoctor(results: DoctorResult[]): string {
  const lines = ["FlowProof doctor", ""];
  for (const result of results) lines.push(`[${result.status.toUpperCase()}] ${result.name}\n  ${result.detail}`);
  const failures = results.filter((result) => result.status === "fail").length;
  const warnings = results.filter((result) => result.status === "warn").length;
  lines.push("", `${failures} failure(s), ${warnings} warning(s)`);
  return lines.join("\n");
}
