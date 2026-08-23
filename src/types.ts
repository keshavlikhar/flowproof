export type Status = "pass" | "fail" | "unknown";
export type Dimension = "correctness" | "delivery-integrity" | "timeliness" | "schema" | "capture-health" | "cost";
export type PolicyProfile = "pilot" | "production";

export interface CustomPolicy {
  required: Dimension[];
  optional?: Dimension[];
}

export interface ResolvedPolicy {
  name: PolicyProfile | "custom" | "legacy-v1";
  required: Dimension[];
  optional: Dimension[];
}

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
  maxDeliveryLagSeconds?: number;
  checksum?: string;
  checksumBuckets?: ChecksumBucket[];
  checksumUnavailableReason?: string;
  activeRowFilter?: string;
}

export interface ChecksumBucket {
  id: string;
  rowCount: number;
  keyChecksum: string;
  contentChecksum: string;
}

export interface CostObservation {
  currentMonthlyUsd?: number;
  projectedMonthlyUsd?: number;
  method?: string;
  confidence?: "low" | "medium" | "high";
}

export interface Snapshot {
  version?: 1 | 2;
  observedAt: string;
  window?: { since: string; until: string };
  source: { tables: Record<string, TableObservation> };
  target: { tables: Record<string, TableObservation> };
  replication?: ReplicationObservation;
  cost?: CostObservation;
}

export interface ReplicationObservation {
  slotName: string;
  found: boolean;
  active?: boolean;
  restartLsn?: string;
  confirmedFlushLsn?: string;
  currentWalLsn?: string;
  unconfirmedWalBytes?: number;
  retainedWalBytes?: number;
  walStatus?: string;
}

export interface TableMapping {
  source: string;
  target: string;
  primaryKey: string[];
  freshnessColumn: string;
  checksumColumns?: string[];
  targetSoftDeleteColumn?: string;
  targetApplyTimestampColumn?: string;
}

export interface ReplicationConfig {
  postgresSlotName: string;
  maxUnconfirmedWalBytes: number;
  maxRetainedWalBytes: number;
}

export interface Config {
  version: 1 | 2;
  pipeline: {
    name: string;
    policy?: PolicyProfile | CustomPolicy;
    rowCountTolerancePercent: number;
    maxLagSeconds: number;
    monthlyCostBudgetUsd: number;
  };
  replication?: ReplicationConfig;
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
  blocking: boolean;
  table?: string;
  summary: string;
  evidence: Evidence[];
  recommendation?: string;
}

export interface AuditReport {
  pipeline: string;
  observedAt: string;
  overall: Status;
  policy: ResolvedPolicy;
  scope: string;
  results: CheckResult[];
}
