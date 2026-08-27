import { ALL_DIMENSIONS } from "./policy.ts";
import type { Config, Dimension, Snapshot } from "./types.ts";

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function finiteNonNegative(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
}

function optionalFiniteNonNegative(value: unknown, label: string): asserts value is number | undefined {
  if (value !== undefined) finiteNonNegative(value, label);
}

function optionalFinite(value: unknown, label: string): asserts value is number | undefined {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be a finite number`);
}

function validateDimensions(value: unknown, label: string, allowEmpty: boolean): Dimension[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => !ALL_DIMENSIONS.includes(item as Dimension))) {
    throw new Error(`${label} must contain valid proof dimensions${allowEmpty ? "" : " and cannot be empty"}`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} cannot contain duplicates`);
  return value as Dimension[];
}

export function validateConfig(value: unknown): asserts value is Config {
  object(value, "config");
  if (value.version !== 1 && value.version !== 2) throw new Error("config.version must be 1 or 2");
  object(value.pipeline, "config.pipeline");
  if (typeof value.pipeline.name !== "string" || !value.pipeline.name.trim()) throw new Error("config.pipeline.name is required");
  if (value.pipeline.policy !== undefined) {
    if (value.pipeline.policy !== "pilot" && value.pipeline.policy !== "production") {
      object(value.pipeline.policy, "config.pipeline.policy");
      const required = validateDimensions(value.pipeline.policy.required, "config.pipeline.policy.required", false);
      const optional = value.pipeline.policy.optional === undefined
        ? []
        : validateDimensions(value.pipeline.policy.optional, "config.pipeline.policy.optional", true);
      const overlap = required.filter((dimension) => optional.includes(dimension));
      if (overlap.length) throw new Error(`config.pipeline.policy dimensions cannot be both required and optional: ${overlap.join(", ")}`);
    }
  }
  finiteNonNegative(value.pipeline.rowCountTolerancePercent, "config.pipeline.rowCountTolerancePercent");
  if (value.pipeline.rowCountTolerancePercent > 100) throw new Error("config.pipeline.rowCountTolerancePercent must be <= 100");
  finiteNonNegative(value.pipeline.maxLagSeconds, "config.pipeline.maxLagSeconds");
  finiteNonNegative(value.pipeline.monthlyCostBudgetUsd, "config.pipeline.monthlyCostBudgetUsd");
  if (value.reconciliation !== undefined) {
    object(value.reconciliation, "config.reconciliation");
    optionalFiniteNonNegative(value.reconciliation.settleDelaySeconds, "config.reconciliation.settleDelaySeconds");
    optionalFiniteNonNegative(value.reconciliation.maxRowsPerTable, "config.reconciliation.maxRowsPerTable");
    if (value.reconciliation.maxRowsPerTable !== undefined && (!Number.isSafeInteger(value.reconciliation.maxRowsPerTable) || value.reconciliation.maxRowsPerTable < 1)) {
      throw new Error("config.reconciliation.maxRowsPerTable must be a positive safe integer");
    }
    if (value.reconciliation.sourceStabilityCheck !== undefined && typeof value.reconciliation.sourceStabilityCheck !== "boolean") {
      throw new Error("config.reconciliation.sourceStabilityCheck must be a boolean");
    }
    optionalFiniteNonNegative(value.reconciliation.maxMismatchBuckets, "config.reconciliation.maxMismatchBuckets");
    if (value.reconciliation.maxMismatchBuckets !== undefined && !Number.isSafeInteger(value.reconciliation.maxMismatchBuckets)) {
      throw new Error("config.reconciliation.maxMismatchBuckets must be a non-negative safe integer");
    }
    optionalFiniteNonNegative(value.reconciliation.maxMismatchRowsPerBucket, "config.reconciliation.maxMismatchRowsPerBucket");
    if (value.reconciliation.maxMismatchRowsPerBucket !== undefined && (!Number.isSafeInteger(value.reconciliation.maxMismatchRowsPerBucket) || value.reconciliation.maxMismatchRowsPerBucket < 1)) {
      throw new Error("config.reconciliation.maxMismatchRowsPerBucket must be a positive safe integer");
    }
  }
  if (value.replication !== undefined) {
    object(value.replication, "config.replication");
    if (typeof value.replication.postgresSlotName !== "string" || !value.replication.postgresSlotName.trim()) {
      throw new Error("config.replication.postgresSlotName is required");
    }
    finiteNonNegative(value.replication.maxUnconfirmedWalBytes, "config.replication.maxUnconfirmedWalBytes");
    finiteNonNegative(value.replication.maxRetainedWalBytes, "config.replication.maxRetainedWalBytes");
  }
  if (value.relay !== undefined) {
    object(value.relay, "config.relay");
    if (value.relay.testOnly !== true) throw new Error("config.relay.testOnly must be true; this relay is not an Openflow implementation");
    for (const field of ["postgresSlotName", "postgresPublicationName", "snowflakeLedgerTable"] as const) {
      if (typeof value.relay[field] !== "string" || !value.relay[field]) throw new Error(`config.relay.${field} is required`);
    }
    if (value.relay.workflow !== undefined && value.relay.workflow !== "direct" && value.relay.workflow !== "openflow-simulated") {
      throw new Error("config.relay.workflow must be direct or openflow-simulated");
    }
    if (value.relay.workflow === "openflow-simulated" && (typeof value.relay.snowflakeJournalTable !== "string" || !value.relay.snowflakeJournalTable)) {
      throw new Error("config.relay.snowflakeJournalTable is required for openflow-simulated workflow");
    }
  }
  if (!Array.isArray(value.tables) || value.tables.length === 0) throw new Error("config.tables must contain at least one mapping");
  for (const [index, mapping] of value.tables.entries()) {
    object(mapping, `config.tables[${index}]`);
    for (const field of ["source", "target", "freshnessColumn"] as const) {
      if (typeof mapping[field] !== "string" || !mapping[field]) throw new Error(`config.tables[${index}].${field} is required`);
    }
    if (!Array.isArray(mapping.primaryKey) || ((value.version === 2 || value.relay !== undefined) && mapping.primaryKey.length === 0) || mapping.primaryKey.some((key) => typeof key !== "string" || !key)) {
      throw new Error(`config.tables[${index}].primaryKey must be an array of column names`);
    }
    if (mapping.targetPrimaryKey !== undefined && (!Array.isArray(mapping.targetPrimaryKey) || mapping.targetPrimaryKey.length !== mapping.primaryKey.length || mapping.targetPrimaryKey.some((key) => typeof key !== "string" || !key))) {
      throw new Error(`config.tables[${index}].targetPrimaryKey must contain one target column for every source primary-key column`);
    }
    if (mapping.checksumColumns !== undefined && (!Array.isArray(mapping.checksumColumns) || mapping.checksumColumns.length === 0 || mapping.checksumColumns.some((column) => typeof column !== "string" || !column))) {
      throw new Error(`config.tables[${index}].checksumColumns must be a non-empty array of column names`);
    }
    if (mapping.columnComparisons !== undefined) {
      if (mapping.checksumColumns !== undefined) throw new Error(`config.tables[${index}] cannot combine checksumColumns and columnComparisons`);
      if (!Array.isArray(mapping.columnComparisons) || mapping.columnComparisons.length === 0) throw new Error(`config.tables[${index}].columnComparisons must be a non-empty array`);
      const comparisons = mapping.columnComparisons as Array<Record<string, unknown>>;
      const primaryKey = mapping.primaryKey as string[];
      const freshnessColumn = mapping.freshnessColumn as string;
      const sourceNames = new Set<string>();
      const targetNames = new Set<string>();
      for (const [comparisonIndex, comparison] of comparisons.entries()) {
        object(comparison, `config.tables[${index}].columnComparisons[${comparisonIndex}]`);
        if (typeof comparison.source !== "string" || !comparison.source) throw new Error(`config.tables[${index}].columnComparisons[${comparisonIndex}].source is required`);
        if (comparison.target !== undefined && (typeof comparison.target !== "string" || !comparison.target)) throw new Error(`config.tables[${index}].columnComparisons[${comparisonIndex}].target must be a column name`);
        const sourceName = comparison.source.toLowerCase();
        const targetName = String(comparison.target ?? comparison.source).toLowerCase();
        if (sourceNames.has(sourceName) || targetNames.has(targetName)) throw new Error(`config.tables[${index}].columnComparisons cannot contain duplicate source or target columns`);
        sourceNames.add(sourceName);
        targetNames.add(targetName);
        if (comparison.normalize !== undefined && !["trim", "lowercase", "uppercase", "lowercase-trim", "uppercase-trim"].includes(String(comparison.normalize))) {
          throw new Error(`config.tables[${index}].columnComparisons[${comparisonIndex}].normalize is unsupported`);
        }
        if (comparison.valueMap !== undefined) {
          object(comparison.valueMap, `config.tables[${index}].columnComparisons[${comparisonIndex}].valueMap`);
          const entries = Object.entries(comparison.valueMap);
          if (!entries.length || entries.length > 100 || entries.some(([key, mapped]) => key.length > 256 || typeof mapped !== "string" || mapped.length > 256)) {
            throw new Error(`config.tables[${index}].columnComparisons[${comparisonIndex}].valueMap must contain 1-100 string mappings of at most 256 characters`);
          }
        }
        if (primaryKey.some((key) => key.toLowerCase() === String(comparison.source).toLowerCase()) && (comparison.normalize !== undefined || comparison.valueMap !== undefined)) {
          throw new Error(`config.tables[${index}] primary-key transformations may rename columns but cannot normalize or remap key values`);
        }
      }
      if (mapping.targetPrimaryKey) {
        for (const [keyIndex, sourceKey] of primaryKey.entries()) {
          const comparison = comparisons.find((item) => String(item.source).toLowerCase() === sourceKey.toLowerCase());
          if (comparison?.target && String(comparison.target).toLowerCase() !== String(mapping.targetPrimaryKey[keyIndex]).toLowerCase()) {
            throw new Error(`config.tables[${index}] has conflicting target mappings for primary-key column ${sourceKey}`);
          }
        }
      }
      const freshnessComparison = comparisons.find((item) => String(item.source).toLowerCase() === freshnessColumn.toLowerCase());
      if (mapping.targetFreshnessColumn && freshnessComparison?.target && String(freshnessComparison.target).toLowerCase() !== String(mapping.targetFreshnessColumn).toLowerCase()) {
        throw new Error(`config.tables[${index}] has conflicting target mappings for freshness column ${mapping.freshnessColumn}`);
      }
    }
    for (const field of ["targetFreshnessColumn", "targetSoftDeleteColumn", "targetInsertTimestampColumn", "targetApplyTimestampColumn"] as const) {
      if (mapping[field] !== undefined && (typeof mapping[field] !== "string" || !mapping[field])) {
        throw new Error(`config.tables[${index}].${field} must be a column name`);
      }
    }
    if (value.relay !== undefined && (mapping.targetPrimaryKey !== undefined || mapping.targetFreshnessColumn !== undefined || mapping.columnComparisons !== undefined)) {
      throw new Error(`config.tables[${index}] transformation contracts are verifier-only and are not supported by the test relay`);
    }
  }
  const sources = value.tables.map((mapping) => mapping.source.toLowerCase());
  const targets = value.tables.map((mapping) => mapping.target.toLowerCase());
  if (new Set(sources).size !== sources.length) throw new Error("config.tables cannot contain duplicate source mappings");
  if (new Set(targets).size !== targets.length) throw new Error("config.tables cannot contain duplicate target mappings");
}

function validateTableObservations(value: unknown, label: string): void {
  object(value, label);
  for (const [tableName, observation] of Object.entries(value)) {
    object(observation, `${label}.${tableName}`);
    if (typeof observation.name !== "string" || !observation.name) throw new Error(`${label}.${tableName}.name is required`);
    if (!Array.isArray(observation.columns)) throw new Error(`${label}.${tableName}.columns must be an array`);
    for (const [index, column] of observation.columns.entries()) {
      object(column, `${label}.${tableName}.columns[${index}]`);
      if (typeof column.name !== "string" || !column.name || typeof column.type !== "string" || !column.type || typeof column.nullable !== "boolean") {
        throw new Error(`${label}.${tableName}.columns[${index}] is invalid`);
      }
      optionalFiniteNonNegative(column.numericPrecision, `${label}.${tableName}.columns[${index}].numericPrecision`);
      optionalFinite(column.numericScale, `${label}.${tableName}.columns[${index}].numericScale`);
      optionalFiniteNonNegative(column.characterMaximumLength, `${label}.${tableName}.columns[${index}].characterMaximumLength`);
      optionalFiniteNonNegative(column.datetimePrecision, `${label}.${tableName}.columns[${index}].datetimePrecision`);
    }
    optionalFiniteNonNegative(observation.rowCount, `${label}.${tableName}.rowCount`);
    optionalFiniteNonNegative(observation.distinctPrimaryKeys, `${label}.${tableName}.distinctPrimaryKeys`);
    optionalFinite(observation.minDeliveryLagSeconds, `${label}.${tableName}.minDeliveryLagSeconds`);
    optionalFinite(observation.p95DeliveryLagSeconds, `${label}.${tableName}.p95DeliveryLagSeconds`);
    optionalFinite(observation.maxDeliveryLagSeconds, `${label}.${tableName}.maxDeliveryLagSeconds`);
    optionalFiniteNonNegative(observation.deliveryLagRowCount, `${label}.${tableName}.deliveryLagRowCount`);
    optionalFiniteNonNegative(observation.missingDeliveryTimestampCount, `${label}.${tableName}.missingDeliveryTimestampCount`);
    if (observation.checksumBuckets !== undefined) {
      if (!Array.isArray(observation.checksumBuckets)) throw new Error(`${label}.${tableName}.checksumBuckets must be an array`);
      const bucketIds = new Set<string>();
      for (const [index, bucket] of observation.checksumBuckets.entries()) {
        object(bucket, `${label}.${tableName}.checksumBuckets[${index}]`);
        if (typeof bucket.id !== "string" || !bucket.id || bucketIds.has(bucket.id)) throw new Error(`${label}.${tableName}.checksumBuckets contains an invalid or duplicate id`);
        bucketIds.add(bucket.id);
        finiteNonNegative(bucket.rowCount, `${label}.${tableName}.checksumBuckets[${index}].rowCount`);
        if (typeof bucket.keyChecksum !== "string" || typeof bucket.contentChecksum !== "string") throw new Error(`${label}.${tableName}.checksumBuckets[${index}] checksums are invalid`);
      }
    }
    if (observation.reconciliationDetails !== undefined) {
      object(observation.reconciliationDetails, `${label}.${tableName}.reconciliationDetails`);
      if (observation.reconciliationDetails.privacy !== "hashed-primary-key" || typeof observation.reconciliationDetails.complete !== "boolean") {
        throw new Error(`${label}.${tableName}.reconciliationDetails is invalid`);
      }
      finiteNonNegative(observation.reconciliationDetails.mismatchedBucketCount, `${label}.${tableName}.reconciliationDetails.mismatchedBucketCount`);
      finiteNonNegative(observation.reconciliationDetails.inspectedBucketCount, `${label}.${tableName}.reconciliationDetails.inspectedBucketCount`);
      if (!Array.isArray(observation.reconciliationDetails.differences) || !Array.isArray(observation.reconciliationDetails.skippedBuckets)) {
        throw new Error(`${label}.${tableName}.reconciliationDetails collections are invalid`);
      }
      for (const [index, difference] of observation.reconciliationDetails.differences.entries()) {
        object(difference, `${label}.${tableName}.reconciliationDetails.differences[${index}]`);
        if (!/^[0-9a-f]{2,4}$/i.test(String(difference.bucketId)) || !/^[0-9a-f]{32}$/i.test(String(difference.keyFingerprint)) || !["missing-target", "unexpected-target", "content-mismatch"].includes(String(difference.kind))) {
          throw new Error(`${label}.${tableName}.reconciliationDetails.differences[${index}] is invalid`);
        }
        finiteNonNegative(difference.sourceRowCount, `${label}.${tableName}.reconciliationDetails.differences[${index}].sourceRowCount`);
        finiteNonNegative(difference.targetRowCount, `${label}.${tableName}.reconciliationDetails.differences[${index}].targetRowCount`);
      }
    }
  }
}

export function validateSnapshot(value: unknown): asserts value is Snapshot {
  object(value, "snapshot");
  if (value.version !== undefined && value.version !== 1 && value.version !== 2) throw new Error("snapshot.version must be 1 or 2");
  if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) throw new Error("snapshot.observedAt must be an ISO-8601 timestamp");
  object(value.source, "snapshot.source");
  object(value.target, "snapshot.target");
  object(value.source.tables, "snapshot.source.tables");
  object(value.target.tables, "snapshot.target.tables");
  validateTableObservations(value.source.tables, "snapshot.source.tables");
  validateTableObservations(value.target.tables, "snapshot.target.tables");
  for (const [side, container] of [["source", value.source], ["target", value.target]] as const) {
    const system = container.system;
    if (system !== undefined) {
      object(system, `snapshot.${side}.system`);
      if (typeof system.databaseTime !== "string" || Number.isNaN(Date.parse(system.databaseTime)) || system.sessionTimezone !== "UTC") {
        throw new Error(`snapshot.${side}.system must contain a valid databaseTime and UTC sessionTimezone`);
      }
    }
  }
  if (value.window !== undefined) {
    object(value.window, "snapshot.window");
    if (typeof value.window.since !== "string" || typeof value.window.until !== "string" || Number.isNaN(Date.parse(value.window.since)) || Number.isNaN(Date.parse(value.window.until))) {
      throw new Error("snapshot.window must contain ISO-8601 since and until timestamps");
    }
    if (Date.parse(value.window.since) >= Date.parse(value.window.until)) throw new Error("snapshot.window.since must be earlier than snapshot.window.until");
    optionalFiniteNonNegative(value.window.settleDelaySeconds, "snapshot.window.settleDelaySeconds");
    if (value.window.closed !== undefined && typeof value.window.closed !== "boolean") throw new Error("snapshot.window.closed must be a boolean");
  }
  if (value.replication !== undefined) {
    object(value.replication, "snapshot.replication");
    if (typeof value.replication.slotName !== "string" || typeof value.replication.found !== "boolean") throw new Error("snapshot.replication is invalid");
    optionalFiniteNonNegative(value.replication.unconfirmedWalBytes, "snapshot.replication.unconfirmedWalBytes");
    optionalFiniteNonNegative(value.replication.retainedWalBytes, "snapshot.replication.retainedWalBytes");
  }
  if (value.cost !== undefined) {
    object(value.cost, "snapshot.cost");
    optionalFiniteNonNegative(value.cost.currentMonthlyUsd, "snapshot.cost.currentMonthlyUsd");
    optionalFiniteNonNegative(value.cost.projectedMonthlyUsd, "snapshot.cost.projectedMonthlyUsd");
    if (value.cost.coverage !== undefined && value.cost.coverage !== "partial" && value.cost.coverage !== "complete") throw new Error("snapshot.cost.coverage is invalid");
    if (value.cost.components !== undefined) {
      if (!Array.isArray(value.cost.components)) throw new Error("snapshot.cost.components must be an array");
      for (const [index, component] of value.cost.components.entries()) {
        object(component, `snapshot.cost.components[${index}]`);
        if (typeof component.name !== "string" || typeof component.source !== "string" || !["measured", "configured", "unavailable"].includes(String(component.status))) {
          throw new Error(`snapshot.cost.components[${index}] is invalid`);
        }
        optionalFiniteNonNegative(component.monthlyUsd, `snapshot.cost.components[${index}].monthlyUsd`);
        optionalFiniteNonNegative(component.credits, `snapshot.cost.components[${index}].credits`);
      }
    }
  }
}
