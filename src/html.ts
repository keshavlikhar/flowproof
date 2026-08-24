import type { AuditReport } from "./types.ts";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderHtml(report: AuditReport): string {
  const results = report.results.map((result) => {
    const evidence = result.evidence.length
      ? `<dl>${result.evidence.map((item) => `<div><dt>${escape(item.label)}</dt><dd>Expected ${escape(item.expected)} · observed ${escape(item.observed)}</dd></div>`).join("")}</dl>`
      : "";
    const recommendation = result.recommendation ? `<p class="next"><strong>Next:</strong> ${escape(result.recommendation)}</p>` : "";
    return `<section class="card ${result.status}">
      <div class="heading"><span class="status">${result.status.toUpperCase()}</span><span class="policy">${result.blocking ? "REQUIRED" : "OPTIONAL"}</span></div>
      <h2>${escape(result.dimension)}${result.table ? ` <small>${escape(result.table)}</small>` : ""}</h2>
      <p>${escape(result.summary)}</p>${evidence}${recommendation}
    </section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowProof · ${escape(report.pipeline)}</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#657089;--line:#dfe4ec;--pass:#13795b;--fail:#c9362b;--unknown:#8a5b00}*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:980px;margin:0 auto;padding:48px 24px 72px}.hero{background:#172033;color:white;border-radius:18px;padding:30px;margin-bottom:20px}.hero h1{margin:0 0 8px;font-size:32px}.hero p{margin:4px 0;color:#d8deea}.overall{display:inline-block;margin-top:14px;padding:6px 11px;border-radius:999px;font-weight:800;background:white;color:var(--ink)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:white;border:1px solid var(--line);border-top:5px solid var(--muted);border-radius:14px;padding:20px;box-shadow:0 4px 16px #1720330a}.card.pass{border-top-color:var(--pass)}.card.fail{border-top-color:var(--fail)}.card.unknown{border-top-color:var(--unknown)}.heading{display:flex;gap:8px}.status,.policy{font-size:11px;font-weight:800;letter-spacing:.08em;padding:3px 7px;border-radius:5px;background:#edf0f5}.pass .status{color:var(--pass)}.fail .status{color:var(--fail)}.unknown .status{color:var(--unknown)}h2{font-size:20px;margin:12px 0 7px}h2 small{display:block;color:var(--muted);font-size:13px;font-weight:500}dl{margin:16px 0 0}dl div{border-top:1px solid var(--line);padding:9px 0}dt{font-weight:700}dd{margin:2px 0 0;color:var(--muted)}.next{background:#f3f5f8;border-radius:8px;padding:10px}.foot{color:var(--muted);margin-top:20px;font-size:13px}
</style></head><body><main>
<header class="hero"><h1>FlowProof: ${report.overall.toUpperCase()}</h1><p>${escape(report.pipeline)} · ${escape(report.observedAt)}</p><p>Policy: ${escape(report.policy.name)} · required: ${escape(report.policy.required.join(", "))}</p><span class="overall">${report.overall.toUpperCase()}</span></header>
<p>${escape(report.scope)}</p><div class="grid">${results}</div>
<p class="foot">Generated locally by FlowProof. This report contains evidence summaries, not source rows or credentials.</p>
</main></body></html>`;
}
