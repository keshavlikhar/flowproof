import type {
  AuditReport,
  CheckResult,
  Column,
  Config,
  Snapshot,
  Status,
  TableMapping,
  TableObservation,
} from "./types.ts";

const TYPE_FAMILIES: Record<string, string> = {
  bigint: "integer", int: "integer", integer: "integer", number: "integer",
  numeric: "decimal", decimal: "decimal", real: "decimal", double: "decimal", float: "decimal",
  varchar: "text", text: "text", string: "text", char: "text",
  boolean: "boolean", bool: "boolean",
  timestamp: "timestamp", timestamp_ntz: "timestamp", timestamp_tz: "timestamp", timestamptz: "timestamp",
  date: "date", json: "semi-structured", jsonb: "semi-structured", variant: "semi-structured",
};

function normalizeType(type: string): string {
  const base = type.toLowerCase().replace(/\(.*/, "").trim();
  return TYPE_FAMILIES[base] ?? base;
}

function unknown(dimension: CheckResult["dimension"], table: string | undefined, summary: string, recommendation: string): CheckResult {
  return { dimension, table, status: "unknown", summary, evidence: [], recommendation };
}

function schemaCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation): CheckResult {
  if (!source || !target) return unknown("schema", mapping.target, "Schema could not be verified because table metadata is missing.", "Collect source and target column metadata.");
  const targetColumns = new Map(target.columns.map((column) => [column.name.toLowerCase(), column]));
  const problems: string[] = [];
  for (const sourceColumn of source.columns) {
    const targetColumn = targetColumns.get(sourceColumn.name.toLowerCase());
    if (!targetColumn) problems.push(`${sourceColumn.name} is missing`);
    else if (normalizeType(sourceColumn.type) !== normalizeType(targetColumn.type)) {
      problems.push(`${sourceColumn.name}: ${sourceColumn.type} -> ${targetColumn.type}`);
    } else if (sourceColumn.nullable === false && targetColumn.nullable === true) {
      problems.push(`${sourceColumn.name} became nullable`);
    }
  }
  return {
    dimension: "schema", table: mapping.target, status: problems.length ? "fail" : "pass",
    summary: problems.length ? `Schema mismatch: ${problems.join("; ")}.` : "Source columns are present with compatible target types and nullability.",
    evidence: [{ label: "columns", expected: `${source.columns.length} compatible source columns`, observed: problems.length ? problems.join("; ") : "all compatible" }],
    recommendation: problems.length ? "Align the target table or explicitly approve and version the mapping." : undefined,
  };
}

function correctnessCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation, tolerance = 0): CheckResult {
  if (!source || !target || source.rowCount === undefined || target.rowCount === undefined) {
    return unknown("correctness", mapping.target, "Completeness could not be verified because row counts are missing.", "Collect counts over the same closed reconciliation window.");
  }
  const denominator = Math.max(source.rowCount, 1);
  const differencePercent = Math.abs(source.rowCount - target.rowCount) / denominator * 100;
  const countMatches = differencePercent <= tolerance;
  const checksumAvailable = source.checksum !== undefined && target.checksum !== undefined;
  const checksumMatches = checksumAvailable && source.checksum === target.checksum;
  const status: Status = countMatches && checksumMatches ? "pass" : checksumAvailable ? "fail" : "unknown";
  return {
    dimension: "correctness", table: mapping.target, status,
    summary: status === "pass" ? "Counts and deterministic checksums match." : status === "fail" ? "Source and target contents do not reconcile." : "Counts match, but content equality is not proven without checksums.",
    evidence: [
      { label: "row count", expected: String(source.rowCount), observed: `${target.rowCount} (${differencePercent.toFixed(2)}% difference)` },
      { label: "checksum", expected: source.checksum ?? "required", observed: target.checksum ?? "not collected" },
    ],
    recommendation: status !== "pass" ? "Compute a stable checksum over the primary key and selected business columns for the same window." : undefined,
  };
}

function exactlyOnceCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation): CheckResult {
  if (!mapping.primaryKey.length) return unknown("exactly-once", mapping.target, "No stable key is configured, so duplicate delivery cannot be tested.", "Configure a primary or idempotency key.");
  if (!source || !target || source.rowCount === undefined || target.rowCount === undefined || target.distinctPrimaryKeys === undefined) {
    return unknown("exactly-once", mapping.target, "Duplicate and missing-key evidence is incomplete.", "Collect target row count, distinct primary-key count, and the matching source count.");
  }
  const duplicates = target.rowCount - target.distinctPrimaryKeys;
  const missingOrExtra = target.distinctPrimaryKeys - source.rowCount;
  const passed = duplicates === 0 && missingOrExtra === 0;
  return {
    dimension: "exactly-once", table: mapping.target, status: passed ? "pass" : "fail",
    summary: passed ? "Every source key appears once in the checked target window." : `${duplicates} duplicate rows and a ${missingOrExtra} key-count delta were detected.`,
    evidence: [
      { label: "duplicate keys", expected: "0", observed: String(duplicates) },
      { label: "source-to-target key delta", expected: "0", observed: String(missingOrExtra) },
    ],
    recommendation: passed ? undefined : "Inspect replay/idempotency behavior and reconcile the affected keys before advancing the watermark.",
  };
}

function timelinessCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation, maxLagSeconds = 0): CheckResult {
  if (!source?.maxFreshnessValue || !target?.maxFreshnessValue) {
    return unknown("timeliness", mapping.target, "Delivery lag could not be measured.", `Collect MAX(${mapping.freshnessColumn}) from source and target.`);
  }
  const sourceTime = Date.parse(source.maxFreshnessValue);
  const targetTime = Date.parse(target.maxFreshnessValue);
  if (Number.isNaN(sourceTime) || Number.isNaN(targetTime)) return unknown("timeliness", mapping.target, "Freshness values are not valid timestamps.", "Return ISO-8601 timestamps from both systems.");
  const lagSeconds = Math.max(0, (sourceTime - targetTime) / 1000);
  const passed = lagSeconds <= maxLagSeconds;
  return {
    dimension: "timeliness", table: mapping.target, status: passed ? "pass" : "fail",
    summary: passed ? `Delivery lag is ${lagSeconds}s, within the SLA.` : `Delivery lag is ${lagSeconds}s, above the ${maxLagSeconds}s SLA.`,
    evidence: [{ label: "lag", expected: `<= ${maxLagSeconds}s`, observed: `${lagSeconds}s` }],
    recommendation: passed ? undefined : "Inspect the replication watermark, connector health, warehouse capacity, and apply schedule.",
  };
}

function costCheck(config: Config, snapshot: Snapshot): CheckResult {
  const projected = snapshot.cost?.projectedMonthlyUsd;
  if (projected === undefined) return unknown("cost", undefined, "Monthly pipeline cost is not available.", "Collect warehouse, serverless, storage, and transfer usage, then apply the account's contracted rates.");
  const budget = config.pipeline.monthlyCostBudgetUsd;
  const passed = projected <= budget;
  const confidence = snapshot.cost?.confidence;
  const status: Status = !passed ? "fail" : confidence === "medium" || confidence === "high" ? "pass" : "unknown";
  return {
    dimension: "cost", status,
    summary: !passed
      ? `Projected monthly cost exceeds budget by $${(projected - budget).toFixed(2)}.`
      : status === "pass"
        ? `Projected monthly cost is within the $${budget.toFixed(2)} budget.`
        : "The partial cost estimate is within budget, but confidence is too low to prove cost control.",
    evidence: [
      { label: "projected monthly cost", expected: `<= $${budget.toFixed(2)}`, observed: `$${projected.toFixed(2)}` },
      { label: "estimation method", expected: "documented", observed: snapshot.cost?.method ?? "not documented" },
      { label: "confidence", expected: "medium or high", observed: confidence ?? "unknown" },
    ],
    recommendation: !passed
      ? "Reduce refresh frequency or compute size, or explicitly approve a higher pipeline budget."
      : status === "unknown"
        ? "Include storage, transfer, and all pipeline compute before treating the budget check as proven."
        : undefined,
  };
}

export function audit(config: Config, snapshot: Snapshot): AuditReport {
  const results: CheckResult[] = [];
  for (const mapping of config.tables) {
    const source = snapshot.source.tables[mapping.source];
    const target = snapshot.target.tables[mapping.target];
    results.push(schemaCheck(mapping, source, target));
    results.push(correctnessCheck(mapping, source, target, config.pipeline.rowCountTolerancePercent));
    results.push(exactlyOnceCheck(mapping, source, target));
    results.push(timelinessCheck(mapping, source, target, config.pipeline.maxLagSeconds));
  }
  results.push(costCheck(config, snapshot));
  const overall: Status = results.some((result) => result.status === "fail") ? "fail" : results.some((result) => result.status === "unknown") ? "unknown" : "pass";
  return {
    pipeline: config.pipeline.name,
    observedAt: snapshot.observedAt,
    overall,
    scope: snapshot.window
      ? `Evidence for the closed window [${snapshot.window.since}, ${snapshot.window.until}); not a universal exactly-once guarantee.`
      : "Point-in-time evidence for configured tables and reconciliation windows; not a universal exactly-once guarantee.",
    results,
  };
}
