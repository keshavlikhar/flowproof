import type { Config, Dimension, ResolvedPolicy } from "./types.ts";

export const ALL_DIMENSIONS: Dimension[] = [
  "schema",
  "correctness",
  "delivery-integrity",
  "timeliness",
  "capture-health",
  "cost",
];

const PILOT_REQUIRED: Dimension[] = ["schema", "correctness", "delivery-integrity", "timeliness"];

export function resolvePolicy(config: Config): ResolvedPolicy {
  const configured = config.pipeline.policy;
  if (!configured) {
    if (config.version === 1) return { name: "legacy-v1", required: [...ALL_DIMENSIONS], optional: [] };
    return {
      name: "pilot",
      required: [...PILOT_REQUIRED],
      optional: ALL_DIMENSIONS.filter((dimension) => !PILOT_REQUIRED.includes(dimension)),
    };
  }
  if (configured === "pilot") {
    return {
      name: "pilot",
      required: [...PILOT_REQUIRED],
      optional: ALL_DIMENSIONS.filter((dimension) => !PILOT_REQUIRED.includes(dimension)),
    };
  }
  if (configured === "production") return { name: "production", required: [...ALL_DIMENSIONS], optional: [] };
  const required = [...configured.required];
  const explicitlyOptional = configured.optional ?? [];
  const optional = [...explicitlyOptional, ...ALL_DIMENSIONS.filter((dimension) => !required.includes(dimension) && !explicitlyOptional.includes(dimension))];
  return { name: "custom", required, optional };
}
