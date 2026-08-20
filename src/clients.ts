import pg from "pg";
import snowflake from "snowflake-sdk";

export interface QueryResult {
  rows: Record<string, unknown>[];
}

export interface QueryClient {
  query(sql: string, binds?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

export interface LiveClients {
  postgres: QueryClient;
  snowflake: QueryClient;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function postgresClient(environment: NodeJS.ProcessEnv = process.env): QueryClient {
  const pool = new pg.Pool({
    connectionString: required(environment, "FLOWPROOF_POSTGRES_URL"),
    application_name: "flowproof",
    max: 1,
    statement_timeout: 60_000,
  });
  return {
    async query(sql, binds = []) {
      const result = await pool.query(sql, binds);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async close() { await pool.end(); },
  };
}

export function snowflakeClient(environment: NodeJS.ProcessEnv = process.env): QueryClient {
  const connection = snowflake.createConnection({
    account: required(environment, "FLOWPROOF_SNOWFLAKE_ACCOUNT"),
    username: required(environment, "FLOWPROOF_SNOWFLAKE_USER"),
    password: required(environment, "FLOWPROOF_SNOWFLAKE_PASSWORD"),
    warehouse: required(environment, "FLOWPROOF_SNOWFLAKE_WAREHOUSE"),
    database: required(environment, "FLOWPROOF_SNOWFLAKE_DATABASE"),
    role: environment.FLOWPROOF_SNOWFLAKE_ROLE,
    schema: environment.FLOWPROOF_SNOWFLAKE_SCHEMA,
    application: "flowproof",
  });

  let connected: Promise<void> | undefined;
  function connect(): Promise<void> {
    connected ??= new Promise((resolve, reject) => {
      connection.connect((error) => error ? reject(error) : resolve());
    });
    return connected;
  }

  return {
    async query(sql, binds = []) {
      await connect();
      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: sql,
          binds,
          complete(error, _statement, rows) {
            if (error) reject(error);
            else resolve({ rows: (rows ?? []) as Record<string, unknown>[] });
          },
        });
      });
    },
    async close() {
      if (!connected) return;
      await new Promise<void>((resolve, reject) => connection.destroy((error) => error ? reject(error) : resolve()));
    },
  };
}

export function liveClients(environment: NodeJS.ProcessEnv = process.env): LiveClients {
  return { postgres: postgresClient(environment), snowflake: snowflakeClient(environment) };
}
