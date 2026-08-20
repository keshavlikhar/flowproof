export type Status = "pass" | "fail" | "unknown";
export type Dimension = "correctness" | "exactly-once" | "timeliness" | "schema" | "cost";

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableObservation {
  name: string;
  columns: Column[];
  rowCount?: number;
  distinctPrimaryKeys?: number;
  maxFreshnessValue?: string;
  checksum?: string;
}

export interface CostObservation {
  currentMonthlyUsd?: number;
  projectedMonthlyUsd?: number;
  method?: string;
  confidence?: "low" | "medium" | "high";
}

export interface Snapshot {
  observedAt: string;
  window?: { since: string; until: string };
  source: { tables: Record<string, TableObservation> };
  target: { tables: Record<string, TableObservation> };
  cost?: CostObservation;
}

export interface TableMapping {
  source: string;
  target: string;
  primaryKey: string[];
  freshnessColumn: string;
}

export interface Config {
  version: 1;
  pipeline: {
    name: string;
    rowCountTolerancePercent: number;
    maxLagSeconds: number;
    monthlyCostBudgetUsd: number;
  };
  tables: TableMapping[];
}

export interface Evidence {
  label: string;
  expected: string;
  observed: string;
}

export interface CheckResult {
  dimension: Dimension;
  status: Status;
  table?: string;
  summary: string;
  evidence: Evidence[];
  recommendation?: string;
}

export interface AuditReport {
  pipeline: string;
  observedAt: string;
  overall: Status;
  scope: string;
  results: CheckResult[];
}
