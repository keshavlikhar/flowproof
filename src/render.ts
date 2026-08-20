import type { AuditReport } from "./types.ts";

const SYMBOL = { pass: "PASS", fail: "FAIL", unknown: "UNKNOWN" } as const;

export function render(report: AuditReport): string {
  const lines = [
    `FlowProof: ${SYMBOL[report.overall]}`,
    `Pipeline: ${report.pipeline}`,
    `Observed: ${report.observedAt}`,
    `Scope: ${report.scope}`,
    "",
  ];
  for (const result of report.results) {
    lines.push(`[${SYMBOL[result.status]}] ${result.dimension}${result.table ? ` — ${result.table}` : ""}`);
    lines.push(`  ${result.summary}`);
    for (const evidence of result.evidence) lines.push(`  ${evidence.label}: expected ${evidence.expected}; observed ${evidence.observed}`);
    if (result.recommendation) lines.push(`  Next: ${result.recommendation}`);
    lines.push("");
  }
  return lines.join("\n");
}
