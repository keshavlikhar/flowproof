import type { Config } from "./types.ts";

export type ContractStatus = "modeled" | "partial" | "unverified";

export interface OpenflowContractItem {
  capability: string;
  status: ContractStatus;
  evidence: string;
  source: string;
}

export interface OpenflowContractReport {
  product: "Snowflake Openflow Connector for PostgreSQL";
  conclusion: "partial";
  disclaimer: string;
  items: OpenflowContractItem[];
}

const setup = "https://docs.snowflake.com/en/user-guide/data-integration/openflow/connectors/postgres/setup";
const about = "https://docs.snowflake.com/en/user-guide/data-integration/openflow/connectors/postgres/about";
const capture = "https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/capturechangepostgresql";
const enrich = "https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/enrichcdcstream";
const merge = "https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/mergesnowflakejournaltable";
const publish = "https://docs.snowflake.com/en/user-guide/data-integration/openflow/processors/publishchangedatasnowpipestreaming";

export function openflowContract(config: Config): OpenflowContractReport {
  const simulated = config.relay?.workflow === "openflow-simulated";
  return {
    product: "Snowflake Openflow Connector for PostgreSQL",
    conclusion: "partial",
    disclaimer: "FlowProof models selected behavior described in Snowflake documentation. It has not executed or certified the Snowflake Openflow runtime.",
    items: [
      { capability: "PostgreSQL logical-WAL capture and manual replication-slot acknowledgement", status: simulated ? "modeled" : "partial", evidence: simulated ? "The relay consumes pgoutput and acknowledges only after its journal transaction commits." : "The direct relay consumes pgoutput, but does not model Openflow journal staging.", source: capture },
      { capability: "Durable staging before asynchronous destination merge", status: simulated ? "modeled" : "unverified", evidence: simulated ? "Capture writes an append-only simulation journal; relay-merge applies it later." : "Enable relay.workflow=openflow-simulated to exercise this boundary.", source: merge },
      { capability: "Insert, update, soft-delete, and Snowflake destination metadata", status: simulated ? "modeled" : "partial", evidence: "Deterministic SQL fixtures exercise mapped DML and configured inserted/updated/deleted columns.", source: about },
      { capability: "One FlowFile per table and Openflow queue/processor state", status: "partial", evidence: "The simulator preserves source table identity, but uses one generic transaction journal rather than Openflow FlowFiles and queues.", source: capture },
      { capability: "Snowpipe Streaming channels and committed offset tokens", status: "unverified", evidence: "The simulator writes SQL tables directly and does not run Snowpipe Streaming.", source: publish },
      { capability: "Initial snapshot and concurrent snapshot/CDC lifecycle", status: "unverified", evidence: "The simulator starts at a logical replication slot and does not implement Openflow snapshot orchestration.", source: setup },
      { capability: "DDL routing, schema generations, and per-table journal rollover", status: "unverified", evidence: "The simulator does not create Openflow journal generations after schema changes.", source: enrich },
      { capability: "PostgreSQL TOAST unchanged-value handling", status: "unverified", evidence: "Openflow-specific placeholder and merge behavior is not emulated.", source: about },
      { capability: "Actual Openflow runtime, deployment, upgrades, and error paths", status: "unverified", evidence: "Requires an enabled Openflow deployment and a real end-to-end pilot.", source: setup },
    ],
  };
}

export function renderOpenflowContract(report: OpenflowContractReport): string {
  const lines = [
    "FlowProof Openflow contract coverage: PARTIAL",
    report.disclaimer,
    "",
  ];
  for (const item of report.items) {
    lines.push(`[${item.status.toUpperCase()}] ${item.capability}`, `  ${item.evidence}`, `  Source: ${item.source}`, "");
  }
  return lines.join("\n").trimEnd();
}
