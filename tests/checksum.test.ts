import test from "node:test";
import assert from "node:assert/strict";
import { checksumQuery } from "../src/checksum.ts";
import type { Column, TableMapping } from "../src/types.ts";

const mapping: TableMapping = {
  source: "public.orders",
  target: "RAW.ORDERS",
  primaryKey: ["id"],
  freshnessColumn: "updated_at",
  checksumColumns: ["id", "amount", "updated_at"],
};

const columns: Column[] = [
  { name: "id", type: "bigint", nullable: false },
  { name: "amount", type: "numeric", nullable: false },
  { name: "updated_at", type: "timestamp with time zone", nullable: false },
];

test("builds matching deterministic bucket structure for PostgreSQL and Snowflake", () => {
  const postgres = checksumQuery("postgres", mapping, columns, "public.orders", "updated_at >= $1");
  const snowflake = checksumQuery("snowflake", mapping, columns, "RAW.ORDERS", "updated_at >= ?");
  for (const sql of [postgres, snowflake]) {
    assert.match(sql, /SUBSTR\(MD5\(key_text\), 1, 2\) AS bucket_id/);
    assert.match(sql, /key_checksum/);
    assert.match(sql, /content_checksum/);
    assert.match(sql, /ORDER BY key_text, content_hash/);
  }
  assert.match(postgres, /AT TIME ZONE 'UTC'/);
  assert.match(snowflake, /CONVERT_TIMEZONE\('UTC', updated_at\)/);
  assert.match(snowflake, /'\\\\1'/);
  // Whole-number decimals need a separate all-zero fractional rule so that
  // PostgreSQL 25.00 and Snowflake 25 canonicalize to the same value.
  assert.ok(postgres.includes(String.raw`'\.0+$'`));
  assert.ok(snowflake.includes(String.raw`'\\.0+$'`));
});

test("refuses unsupported checksum types instead of producing weak evidence", () => {
  const unsupported = [...columns, { name: "payload", type: "jsonb", nullable: true }];
  const withPayload = { ...mapping, checksumColumns: ["payload"] };
  assert.throws(() => checksumQuery("postgres", withPayload, unsupported, "public.orders", "1=1"), /unsupported type jsonb/);
});
