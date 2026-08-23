import { ALL_DIMENSIONS } from "./policy.ts";
import type { Config, Dimension, Snapshot } from "./types.ts";

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function finiteNonNegative(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
}

function optionalFiniteNonNegative(value: unknown, label: string): void {
  if (value !== undefined) finiteNonNegative(value, label);
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
  if (value.replication !== undefined) {
    object(value.replication, "config.replication");
    if (typeof value.replication.postgresSlotName !== "string" || !value.replication.postgresSlotName.trim()) {
      throw new Error("config.replication.postgresSlotName is required");
    }
    finiteNonNegative(value.replication.maxUnconfirmedWalBytes, "config.replication.maxUnconfirmedWalBytes");
    finiteNonNegative(value.replication.maxRetainedWalBytes, "config.replication.maxRetainedWalBytes");
  }
  if (!Array.isArray(value.tables) || value.tables.length === 0) throw new Error("config.tables must contain at least one mapping");
  for (const [index, mapping] of value.tables.entries()) {
    object(mapping, `config.tables[${index}]`);
    for (const field of ["source", "target", "freshnessColumn"] as const) {
      if (typeof mapping[field] !== "string" || !mapping[field]) throw new Error(`config.tables[${index}].${field} is required`);
    }
    if (!Array.isArray(mapping.primaryKey) || (value.version === 2 && mapping.primaryKey.length === 0) || mapping.primaryKey.some((key) => typeof key !== "string" || !key)) {
      throw new Error(`config.tables[${index}].primaryKey must be an array of column names`);
    }
    if (mapping.checksumColumns !== undefined && (!Array.isArray(mapping.checksumColumns) || mapping.checksumColumns.length === 0 || mapping.checksumColumns.some((column) => typeof column !== "string" || !column))) {
      throw new Error(`config.tables[${index}].checksumColumns must be a non-empty array of column names`);
    }
    for (const field of ["targetSoftDeleteColumn", "targetApplyTimestampColumn"] as const) {
      if (mapping[field] !== undefined && (typeof mapping[field] !== "string" || !mapping[field])) {
        throw new Error(`config.tables[${index}].${field} must be a column name`);
      }
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
    }
    optionalFiniteNonNegative(observation.rowCount, `${label}.${tableName}.rowCount`);
    optionalFiniteNonNegative(observation.distinctPrimaryKeys, `${label}.${tableName}.distinctPrimaryKeys`);
    optionalFiniteNonNegative(observation.maxDeliveryLagSeconds, `${label}.${tableName}.maxDeliveryLagSeconds`);
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
  if (value.window !== undefined) {
    object(value.window, "snapshot.window");
    if (typeof value.window.since !== "string" || typeof value.window.until !== "string" || Number.isNaN(Date.parse(value.window.since)) || Number.isNaN(Date.parse(value.window.until))) {
      throw new Error("snapshot.window must contain ISO-8601 since and until timestamps");
    }
    if (Date.parse(value.window.since) >= Date.parse(value.window.until)) throw new Error("snapshot.window.since must be earlier than snapshot.window.until");
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
  }
}
