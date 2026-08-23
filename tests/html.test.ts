import test from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../src/html.ts";
import type { AuditReport } from "../src/types.ts";

test("renders a self-contained escaped HTML report", () => {
  const report: AuditReport = {
    pipeline: "orders <pilot>", observedAt: "2026-01-01T00:00:00Z", overall: "pass",
    policy: { name: "pilot", required: ["correctness"], optional: ["cost"] }, scope: "closed window",
    results: [{ dimension: "correctness", table: "RAW.ORDERS", status: "pass", blocking: true, summary: "matched", evidence: [{ label: "rows", expected: "2", observed: "2" }] }],
  };
  const html = renderHtml(report);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /orders &lt;pilot&gt;/);
  assert.match(html, /REQUIRED/);
  assert.doesNotMatch(html, /orders <pilot>/);
});
