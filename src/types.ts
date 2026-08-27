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
  numericPrecision?: number;
  numericScale?: number;
  characterMaximumLength?: number;
  datetimePrecision?: number;
}

export interface TableObservation {
  name: string;
  columns: Column[];
  rowCount?: number;
  distinctPrimaryKeys?: number;
  maxFreshnessValue?: string;
  minDeliveryLagSeconds?: number;
  p95DeliveryLagSeconds?: number;
  maxDeliveryLagSeconds?: number;
  deliveryLagRowCount?: number;
  missingDeliveryTimestampCount?: number;
  checksum?: string;
  checksumBuckets?: ChecksumBucket[];
  checksumBucketPrefixLength?: number;
  checksumUnavailableReason?: string;
  activeRowFilter?: string;
  stableDuringCollection?: boolean;
  stabilityEvidence?: string;
  reconciliationDetails?: ReconciliationDetails;
}

export interface ChecksumBucket {
  id: string;
  rowCount: number;
  keyChecksum: string;
  contentChecksum: string;
}

export type DifferenceKind = "missing-target" | "unexpected-target" | "content-mismatch";

export interface RowDifference {
  bucketId: string;
  keyFingerprint: string;
  kind: DifferenceKind;
  sourceRowCount: number;
  targetRowCount: number;
}

export interface ReconciliationDetails {
  privacy: "hashed-primary-key";
  mismatchedBucketCount: number;
  inspectedBucketCount: number;
  complete: boolean;
  differences: RowDifference[];
  skippedBuckets: Array<{ id: string; reason: string }>;
}

export type ColumnNormalization = "trim" | "lowercase" | "uppercase" | "lowercase-trim" | "uppercase-trim";

export interface ColumnComparison {
  source: string;
  target?: string;
  normalize?: ColumnNormalization;
  valueMap?: Record<string, string>;
}

export interface CostObservation {
  currentMonthlyUsd?: number;
  projectedMonthlyUsd?: number;
  method?: string;
  confidence?: "low" | "medium" | "high";
  coverage?: "partial" | "complete";
  components?: Array<{
    name: string;
    monthlyUsd?: number;
    credits?: number;
    source: string;
    status: "measured" | "configured" | "unavailable";
    dataThrough?: string;
    reason?: string;
  }>;
  missingComponents?: string[];
}

export interface Snapshot {
  version?: 1 | 2;
  observedAt: string;
  window?: {
    since: string;
    until: string;
    settleDelaySeconds?: number;
    closed?: boolean;
    closureReason?: string;
  };
  source: { system?: SystemObservation; tables: Record<string, TableObservation> };
  target: { system?: SystemObservation; tables: Record<string, TableObservation> };
  replication?: ReplicationObservation;
  cost?: CostObservation;
}

export interface SystemObservation {
  databaseTime: string;
  sessionTimezone: string;
  databaseVersion?: string;
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
  targetPrimaryKey?: string[];
  freshnessColumn: string;
  targetFreshnessColumn?: string;
  checksumColumns?: string[];
  columnComparisons?: ColumnComparison[];
  targetSoftDeleteColumn?: string;
  targetInsertTimestampColumn?: string;
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
  reconciliation?: {
    settleDelaySeconds?: number;
    maxRowsPerTable?: number;
    sourceStabilityCheck?: boolean;
    maxMismatchBuckets?: number;
    maxMismatchRowsPerBucket?: number;
  };
  replication?: ReplicationConfig;
  relay?: {
    testOnly: true;
    workflow?: "direct" | "openflow-simulated";
    postgresSlotName: string;
    postgresPublicationName: string;
    snowflakeLedgerTable: string;
    snowflakeJournalTable?: string;
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
