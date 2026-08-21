import type {
  AuditReport,
  CheckResult,
  Column,
  Config,
  ChecksumBucket,
  Snapshot,
  Status,
  TableMapping,
  TableObservation,
} from "./types.ts";

const TYPE_FAMILIES: Record<string, string> = {
  smallint: "integer", bigint: "integer", int: "integer", integer: "integer", number: "number",
  numeric: "decimal", decimal: "decimal", real: "decimal", double: "decimal", "double precision": "decimal", float: "decimal",
  varchar: "text", "character varying": "text", character: "text", text: "text", string: "text", char: "text", uuid: "text",
  boolean: "boolean", bool: "boolean",
  timestamp: "timestamp", "timestamp without time zone": "timestamp", "timestamp with time zone": "timestamp", timestamp_ntz: "timestamp", timestamp_tz: "timestamp", timestamptz: "timestamp",
  date: "date", json: "semi-structured", jsonb: "semi-structured", variant: "semi-structured",
};

function normalizeType(type: string): string {
  const base = type.toLowerCase().replace(/\(.*/, "").trim();
  return TYPE_FAMILIES[base] ?? base;
}

function compatibleType(sourceType: string, targetType: string): boolean {
  const source = normalizeType(sourceType);
  const target = normalizeType(targetType);
  return source === target || target === "number" && (source === "integer" || source === "decimal");
}

function unknown(dimension: CheckResult["dimension"], table: string | undefined, summary: string, recommendation: string): CheckResult {
  return { dimension, table, status: "unknown", summary, evidence: [], recommendation };
}

function bucketDifferences(
  source: ChecksumBucket[],
  target: ChecksumBucket[],
  field: "keyChecksum" | "contentChecksum",
): string[] {
  const sourceById = new Map(source.map((bucket) => [bucket.id, bucket]));
  const targetById = new Map(target.map((bucket) => [bucket.id, bucket]));
  const ids = new Set([...sourceById.keys(), ...targetById.keys()]);
  return [...ids].sort().filter((id) => {
    const expected = sourceById.get(id);
    const observed = targetById.get(id);
    return !expected || !observed || expected.rowCount !== observed.rowCount || expected[field] !== observed[field];
  });
}

function bucketCoverageMatches(observation: TableObservation): boolean {
  return observation.checksumBuckets?.reduce((total, bucket) => total + bucket.rowCount, 0) === observation.rowCount;
}

function schemaCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation): CheckResult {
  if (!source || !target) return unknown("schema", mapping.target, "Schema could not be verified because table metadata is missing.", "Collect source and target column metadata.");
  const targetColumns = new Map(target.columns.map((column) => [column.name.toLowerCase(), column]));
  const problems: string[] = [];
  for (const sourceColumn of source.columns) {
    const targetColumn = targetColumns.get(sourceColumn.name.toLowerCase());
    if (!targetColumn) problems.push(`${sourceColumn.name} is missing`);
    else if (!compatibleType(sourceColumn.type, targetColumn.type)) {
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
  const bucketChecksumsAvailable = source.checksumBuckets !== undefined && target.checksumBuckets !== undefined;
  const mismatchedBuckets = bucketChecksumsAvailable
    ? bucketDifferences(source.checksumBuckets!, target.checksumBuckets!, "contentChecksum")
    : [];
  if (bucketChecksumsAvailable && (!bucketCoverageMatches(source) || !bucketCoverageMatches(target))) mismatchedBuckets.unshift("coverage");
  const legacyChecksumAvailable = source.checksum !== undefined && target.checksum !== undefined;
  const checksumAvailable = bucketChecksumsAvailable || legacyChecksumAvailable;
  const checksumMatches = bucketChecksumsAvailable ? mismatchedBuckets.length === 0 : legacyChecksumAvailable && source.checksum === target.checksum;
  const status: Status = !countMatches ? "fail" : !checksumAvailable ? "unknown" : checksumMatches ? "pass" : "fail";
  const checksumObserved = bucketChecksumsAvailable
    ? mismatchedBuckets.length ? `mismatch in buckets ${mismatchedBuckets.slice(0, 10).join(", ")}${mismatchedBuckets.length > 10 ? "…" : ""}` : `${source.checksumBuckets!.length} checksum bucket${source.checksumBuckets!.length === 1 ? "" : "s"} match`
    : target.checksum ?? target.checksumUnavailableReason ?? "not collected";
  return {
    dimension: "correctness", table: mapping.target, status,
    summary: status === "pass" ? "Counts and deterministic checksums match." : status === "fail" ? "Source and target contents do not reconcile." : "Counts match, but content equality is not proven without checksums.",
    evidence: [
      { label: "row count", expected: String(source.rowCount), observed: `${target.rowCount} (${differencePercent.toFixed(2)}% difference)` },
      { label: "content checksum", expected: bucketChecksumsAvailable ? "all deterministic buckets match" : source.checksum ?? "required", observed: checksumObserved },
    ],
    recommendation: status !== "pass" ? "Compute deterministic bucket checksums over the same closed window, then inspect only mismatched buckets." : undefined,
  };
}

function exactlyOnceCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation): CheckResult {
  if (!mapping.primaryKey.length) return unknown("exactly-once", mapping.target, "No stable key is configured, so duplicate delivery cannot be tested.", "Configure a primary or idempotency key.");
  if (!source || !target || source.rowCount === undefined || target.rowCount === undefined || source.distinctPrimaryKeys === undefined || target.distinctPrimaryKeys === undefined) {
    return unknown("exactly-once", mapping.target, "Duplicate and missing-key evidence is incomplete.", "Collect target row count, distinct primary-key count, and the matching source count.");
  }
  const sourceDuplicates = source.rowCount - source.distinctPrimaryKeys;
  const targetDuplicates = target.rowCount - target.distinctPrimaryKeys;
  const keyCountDelta = target.distinctPrimaryKeys - source.distinctPrimaryKeys;
  const keyChecksumsAvailable = source.checksumBuckets !== undefined && target.checksumBuckets !== undefined;
  const mismatchedBuckets = keyChecksumsAvailable
    ? bucketDifferences(source.checksumBuckets!, target.checksumBuckets!, "keyChecksum")
    : [];
  if (keyChecksumsAvailable && (!bucketCoverageMatches(source) || !bucketCoverageMatches(target))) mismatchedBuckets.unshift("coverage");
  const hasKnownFailure = sourceDuplicates !== 0 || targetDuplicates !== 0 || keyCountDelta !== 0 || mismatchedBuckets.length !== 0;
  const status: Status = hasKnownFailure ? "fail" : keyChecksumsAvailable ? "pass" : "unknown";
  return {
    dimension: "exactly-once", table: mapping.target, status,
    summary: status === "pass"
      ? "The active source and target key sets match, with no duplicate keys in the checked window."
      : status === "fail"
        ? `Key reconciliation failed in ${mismatchedBuckets.length} checksum bucket(s); source duplicates ${sourceDuplicates}, target duplicates ${targetDuplicates}, key-count delta ${keyCountDelta}.`
        : "Counts contain no duplicate-key signal, but matching key sets are not proven without key checksums.",
    evidence: [
      { label: "source duplicate keys", expected: "0", observed: String(sourceDuplicates) },
      { label: "target duplicate keys", expected: "0", observed: String(targetDuplicates) },
      { label: "source-to-target key-count delta", expected: "0", observed: String(keyCountDelta) },
      { label: "key-set checksum", expected: "all deterministic buckets match", observed: keyChecksumsAvailable ? mismatchedBuckets.length ? `mismatch in ${mismatchedBuckets.join(", ")}` : "all buckets match" : "not collected" },
    ],
    recommendation: status === "pass" ? undefined : status === "fail" ? "Inspect the mismatched buckets and reconcile their primary keys before advancing the proof window." : "Collect deterministic key checksums; equal counts alone cannot prove the same keys arrived.",
  };
}

function timelinessCheck(mapping: TableMapping, source?: TableObservation, target?: TableObservation, maxLagSeconds = 0): CheckResult {
  if (target?.maxDeliveryLagSeconds !== undefined) {
    const passed = target.maxDeliveryLagSeconds <= maxLagSeconds;
    return {
      dimension: "timeliness", table: mapping.target, status: passed ? "pass" : "fail",
      summary: passed
        ? `Maximum observed source-update-to-target-apply lag is ${target.maxDeliveryLagSeconds}s, within the SLA.`
        : `Maximum observed source-update-to-target-apply lag is ${target.maxDeliveryLagSeconds}s, above the ${maxLagSeconds}s SLA.`,
      evidence: [{ label: "delivery lag", expected: `<= ${maxLagSeconds}s`, observed: `${target.maxDeliveryLagSeconds}s` }],
      recommendation: passed ? undefined : "Inspect Openflow queues, journal merges, warehouse capacity, and the connector apply schedule.",
    };
  }
  if (!source?.maxFreshnessValue || !target?.maxFreshnessValue) {
    return unknown("timeliness", mapping.target, "Delivery lag could not be measured.", `Collect MAX(${mapping.freshnessColumn}) from source and target.`);
  }
  const sourceTime = Date.parse(source.maxFreshnessValue);
  const targetTime = Date.parse(target.maxFreshnessValue);
  if (Number.isNaN(sourceTime) || Number.isNaN(targetTime)) return unknown("timeliness", mapping.target, "Freshness values are not valid timestamps.", "Return ISO-8601 timestamps from both systems.");
  const lagSeconds = Math.max(0, (sourceTime - targetTime) / 1000);
  const definitelyBehind = lagSeconds > maxLagSeconds;
  return {
    dimension: "timeliness", table: mapping.target, status: definitelyBehind ? "fail" : "unknown",
    summary: definitelyBehind
      ? `The target freshness watermark is ${lagSeconds}s behind the source, above the ${maxLagSeconds}s SLA.`
      : "Freshness watermarks are aligned, but they do not prove delivery latency without a target apply timestamp.",
    evidence: [{ label: "freshness watermark gap", expected: `<= ${maxLagSeconds}s`, observed: `${lagSeconds}s` }],
    recommendation: definitelyBehind ? "Inspect the replication watermark, connector health, warehouse capacity, and apply schedule." : "Configure the Openflow target apply timestamp column to measure delivery latency.",
  };
}

function captureCheck(config: NonNullable<Config["replication"]>, snapshot: Snapshot): CheckResult {
  const observed = snapshot.replication;
  if (!observed) return unknown("capture", undefined, "PostgreSQL replication-slot evidence was not collected.", "Collect the configured logical replication slot state from pg_replication_slots.");
  if (!observed.found) {
    return {
      dimension: "capture", status: "fail", summary: `Logical replication slot ${config.postgresSlotName} was not found.`, evidence: [],
      recommendation: "Confirm the Openflow CaptureChangePostgreSQL processor's replication slot name and connector state.",
    };
  }
  const evidenceComplete = observed.active !== undefined && observed.unconfirmedWalBytes !== undefined && observed.retainedWalBytes !== undefined && observed.walStatus !== undefined;
  if (!evidenceComplete) return unknown("capture", undefined, "The replication slot exists, but its progress evidence is incomplete.", "Collect active state, confirmed_flush_lsn, restart_lsn, and WAL byte differences.");
  const unsafeStatus = observed.walStatus !== "reserved" && observed.walStatus !== "extended";
  const unconfirmedTooLarge = observed.unconfirmedWalBytes! > config.maxUnconfirmedWalBytes;
  const retainedTooLarge = observed.retainedWalBytes! > config.maxRetainedWalBytes;
  const passed = observed.active === true && !unsafeStatus && !unconfirmedTooLarge && !retainedTooLarge;
  return {
    dimension: "capture", status: passed ? "pass" : "fail",
    summary: passed
      ? `Replication slot ${observed.slotName} is active and within configured WAL limits.`
      : `Replication slot ${observed.slotName} is inactive, unsafe, or beyond a configured WAL limit.`,
    evidence: [
      { label: "active", expected: "true", observed: String(observed.active) },
      { label: "confirmed flush LSN", expected: "present", observed: observed.confirmedFlushLsn ?? "missing" },
      { label: "unconfirmed WAL", expected: `<= ${config.maxUnconfirmedWalBytes} bytes`, observed: `${observed.unconfirmedWalBytes} bytes` },
      { label: "retained WAL", expected: `<= ${config.maxRetainedWalBytes} bytes`, observed: `${observed.retainedWalBytes} bytes` },
      { label: "WAL status", expected: "reserved or extended", observed: observed.walStatus ?? "unknown" },
    ],
    recommendation: passed ? undefined : "Check connector health and queues before WAL retention fills PostgreSQL disk; repair or recreate an invalidated slot carefully.",
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
  if (config.replication) results.push(captureCheck(config.replication, snapshot));
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
