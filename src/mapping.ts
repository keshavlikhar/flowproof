import type { TableMapping } from "./types.ts";

export function targetColumn(mapping: TableMapping, sourceName: string): string {
  return mapping.columnComparisons?.find((comparison) => comparison.source.toLowerCase() === sourceName.toLowerCase())?.target ?? sourceName;
}

export function targetPrimaryKeys(mapping: TableMapping): string[] {
  return mapping.targetPrimaryKey ?? mapping.primaryKey.map((sourceName) => targetColumn(mapping, sourceName));
}

export function targetFreshness(mapping: TableMapping): string {
  return mapping.targetFreshnessColumn ?? targetColumn(mapping, mapping.freshnessColumn);
}
