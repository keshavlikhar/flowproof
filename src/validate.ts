import type { Config, Snapshot } from "./types.ts";

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function finiteNonNegative(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
}

export function validateConfig(value: unknown): asserts value is Config {
  object(value, "config");
  if (value.version !== 1) throw new Error("config.version must be 1");
  object(value.pipeline, "config.pipeline");
  if (typeof value.pipeline.name !== "string" || !value.pipeline.name.trim()) throw new Error("config.pipeline.name is required");
  finiteNonNegative(value.pipeline.rowCountTolerancePercent, "config.pipeline.rowCountTolerancePercent");
  finiteNonNegative(value.pipeline.maxLagSeconds, "config.pipeline.maxLagSeconds");
  finiteNonNegative(value.pipeline.monthlyCostBudgetUsd, "config.pipeline.monthlyCostBudgetUsd");
  if (!Array.isArray(value.tables) || value.tables.length === 0) throw new Error("config.tables must contain at least one mapping");
  for (const [index, mapping] of value.tables.entries()) {
    object(mapping, `config.tables[${index}]`);
    for (const field of ["source", "target", "freshnessColumn"] as const) {
      if (typeof mapping[field] !== "string" || !mapping[field]) throw new Error(`config.tables[${index}].${field} is required`);
    }
    if (!Array.isArray(mapping.primaryKey) || mapping.primaryKey.some((key) => typeof key !== "string" || !key)) {
      throw new Error(`config.tables[${index}].primaryKey must be an array of column names`);
    }
  }
}

export function validateSnapshot(value: unknown): asserts value is Snapshot {
  object(value, "snapshot");
  if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) throw new Error("snapshot.observedAt must be an ISO-8601 timestamp");
  object(value.source, "snapshot.source");
  object(value.target, "snapshot.target");
  object(value.source.tables, "snapshot.source.tables");
  object(value.target.tables, "snapshot.target.tables");
  if (value.window !== undefined) {
    object(value.window, "snapshot.window");
    if (typeof value.window.since !== "string" || typeof value.window.until !== "string" || Number.isNaN(Date.parse(value.window.since)) || Number.isNaN(Date.parse(value.window.until))) {
      throw new Error("snapshot.window must contain ISO-8601 since and until timestamps");
    }
  }
}
