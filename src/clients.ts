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

function snowflakeBind(value: unknown): snowflake.Bind {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`Unsupported Snowflake bind value type: ${typeof value}`);
}

export function postgresClient(environment: NodeJS.ProcessEnv = process.env): QueryClient {
  const pool = new pg.Pool({
    connectionString: required(environment, "FLOWPROOF_POSTGRES_URL"),
    application_name: "flowproof",
    max: 1,
    statement_timeout: 60_000,
    options: "-c timezone=UTC",
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
  const privateKeyPath = environment.FLOWPROOF_SNOWFLAKE_PRIVATE_KEY_PATH;
  const authentication = privateKeyPath
    ? { authenticator: "SNOWFLAKE_JWT", privateKeyPath, privateKeyPass: environment.FLOWPROOF_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE }
    : { password: required(environment, "FLOWPROOF_SNOWFLAKE_PASSWORD") };
  const connection = snowflake.createConnection({
    account: required(environment, "FLOWPROOF_SNOWFLAKE_ACCOUNT"),
    username: required(environment, "FLOWPROOF_SNOWFLAKE_USER"),
    ...authentication,
    warehouse: required(environment, "FLOWPROOF_SNOWFLAKE_WAREHOUSE"),
    database: required(environment, "FLOWPROOF_SNOWFLAKE_DATABASE"),
    role: environment.FLOWPROOF_SNOWFLAKE_ROLE,
    schema: environment.FLOWPROOF_SNOWFLAKE_SCHEMA,
    application: "flowproof",
    timeout: 60_000,
    retryTimeout: 0,
    sfRetryMaxLoginRetries: 1,
  });

  let connected: Promise<void> | undefined;
  function executeConnected(sqlText: string, binds: unknown[] = []): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      connection.execute({
        sqlText,
        binds: binds.map(snowflakeBind),
        complete(error, _statement, rows) {
          if (error) reject(error);
          else resolve({ rows: (rows ?? []) as Record<string, unknown>[] });
        },
      });
    });
  }

  function connect(): Promise<void> {
    connected ??= new Promise<void>((resolve, reject) => {
      connection.connect((error) => error ? reject(error) : resolve());
    }).then(async () => {
      await executeConnected("ALTER SESSION SET TIMEZONE = 'UTC'");
      await executeConnected("ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 120");
    });
    return connected;
  }

  return {
    async query(sql, binds = []) {
      await connect();
      return executeConnected(sql, binds);
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
