import type { AuditReport } from "./types.ts";

const SYMBOL = { pass: "PASS", fail: "FAIL", unknown: "UNKNOWN" } as const;

export function render(report: AuditReport): string {
  const lines = [
    `FlowProof: ${SYMBOL[report.overall]}`,
    `Pipeline: ${report.pipeline}`,
    `Observed: ${report.observedAt}`,
    `Policy: ${report.policy.name} (required: ${report.policy.required.join(", ")})`,
    `Scope: ${report.scope}`,
    "",
  ];
  for (const result of report.results) {
    lines.push(`[${SYMBOL[result.status]}] [${result.blocking ? "REQUIRED" : "OPTIONAL"}] ${result.dimension}${result.table ? ` — ${result.table}` : ""}`);
    lines.push(`  ${result.summary}`);
    for (const evidence of result.evidence) lines.push(`  ${evidence.label}: expected ${evidence.expected}; observed ${evidence.observed}`);
    if (result.recommendation) lines.push(`  Next: ${result.recommendation}`);
    lines.push("");
  }
  return lines.join("\n");
}
