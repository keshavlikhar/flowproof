#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { audit } from "./audit.ts";
import { render } from "./render.ts";
import { queryPlan } from "./sql.ts";
import type { Config, Snapshot } from "./types.ts";
import { validateConfig, validateSnapshot } from "./validate.ts";
import { collectSnapshot } from "./collect.ts";
import { diagnose, renderDoctor } from "./doctor.ts";
import { renderHtml } from "./html.ts";
import { runRelay, runRelayMerge, setupRelay } from "./relay.ts";
import { openflowContract, renderOpenflowContract } from "./openflow-contract.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function writeHtml(report: ReturnType<typeof audit>): Promise<void> {
  const htmlPath = argument("--html");
  if (!htmlPath) return;
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, renderHtml(report), { mode: 0o600 });
  console.error(`HTML report: ${htmlPath}`);
}

async function verify(config: Config, since: string, until: string, saveSnapshot?: string): Promise<ReturnType<typeof audit>> {
  const { liveClients } = await import("./clients.ts");
  const clients = liveClients();
  let snapshot: Snapshot;
  try {
    snapshot = await collectSnapshot(config, clients, { since, until });
  } finally {
    await Promise.allSettled([clients.postgres.close(), clients.snowflake.close()]);
  }
  if (saveSnapshot) {
    await mkdir(dirname(saveSnapshot), { recursive: true });
    await writeFile(saveSnapshot, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return audit(config, snapshot);
}

function printReport(report: ReturnType<typeof audit>): void {
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report));
}

function setReportExitCode(report: ReturnType<typeof audit>): void {
  process.exitCode = report.overall === "fail" ? 1 : report.overall === "unknown" ? 2 : 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const configPath = argument("--config");
  if (!configPath || !["audit", "plan", "verify", "doctor", "watch", "relay-setup", "relay-run", "relay-merge", "openflow-contract"].includes(command)) {
    console.error("Usage:\n  flowproof audit --config flowproof.json --snapshot snapshot.json [--json] [--html report.html]\n  flowproof plan --config flowproof.json\n  flowproof doctor --config flowproof.json\n  flowproof verify --config flowproof.json --since <ISO> --until <ISO> [--json] [--html report.html] [--save-snapshot path]\n  flowproof watch --config flowproof.json [--window-minutes 60] [--interval-seconds 300] [--once] [--html report.html]\n  flowproof relay-setup --config flowproof.json\n  flowproof relay-run --config flowproof.json [--max-transactions 1]\n  flowproof relay-merge --config flowproof.json [--max-transactions 1]\n  flowproof openflow-contract --config flowproof.json [--json]");
    process.exitCode = 2;
    return;
  }
  const config = await jsonFile<Config>(configPath);
  validateConfig(config);
  if (command === "openflow-contract") {
    const report = openflowContract(config);
    console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : renderOpenflowContract(report));
    return;
  }
  if (command === "plan") {
    console.log(queryPlan(config));
    return;
  }
  if (command === "relay-setup") {
    console.error("TEST ONLY: this validates FlowProof's WAL/acknowledgement logic; it does not validate Snowflake Openflow.");
    for (const message of await setupRelay(config)) console.log(message);
    return;
  }
  if (command === "relay-run") {
    console.error("TEST ONLY: documented-contract simulator, not a test of the Snowflake Openflow runtime. Run only one instance per slot.");
    const maxTransactions = argument("--max-transactions") === undefined ? undefined : positiveInteger("--max-transactions", 1);
    const processed = await runRelay(config, process.env, maxTransactions);
    console.log(`Relay stopped after ${processed} committed transaction(s).`);
    return;
  }
  if (command === "relay-merge") {
    console.error("TEST ONLY: simulated journal merge, not Snowflake Openflow.");
    const merged = await runRelayMerge(config, process.env, positiveInteger("--max-transactions", 1));
    console.log(`Merged ${merged} journaled transaction(s).`);
    return;
  }
  if (command === "doctor") {
    const { liveClients } = await import("./clients.ts");
    const clients = liveClients();
    let results;
    try {
      results = await diagnose(config, clients);
    } finally {
      await Promise.allSettled([clients.postgres.close(), clients.snowflake.close()]);
    }
    console.log(process.argv.includes("--json") ? JSON.stringify(results, null, 2) : renderDoctor(results));
    process.exitCode = results.some((result) => result.status === "fail") ? 1 : 0;
    return;
  }
  if (command === "verify") {
    const since = argument("--since");
    const until = argument("--until");
    if (!since || !until) throw new Error("verify requires an explicit closed window: --since <ISO> --until <ISO>");
    const report = await verify(config, since, until, argument("--save-snapshot"));
    printReport(report);
    await writeHtml(report);
    setReportExitCode(report);
    return;
  }
  if (command === "watch") {
    const windowMinutes = positiveInteger("--window-minutes", 60);
    const intervalSeconds = positiveInteger("--interval-seconds", 300);
    const once = process.argv.includes("--once");
    let stopping = false;
    let wake: (() => void) | undefined;
    const stop = () => { stopping = true; wake?.(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    while (!stopping) {
      const settleSeconds = config.reconciliation?.settleDelaySeconds ?? 0;
      const untilMs = Math.floor((Date.now() - settleSeconds * 1000) / 60_000) * 60_000;
      const until = new Date(untilMs).toISOString();
      const since = new Date(untilMs - windowMinutes * 60_000).toISOString();
      const report = await verify(config, since, until);
      printReport(report);
      await writeHtml(report);
      if (once) {
        setReportExitCode(report);
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, intervalSeconds * 1000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    return;
  }
  const snapshotPath = argument("--snapshot");
  if (!snapshotPath) throw new Error("audit requires --snapshot");
  const snapshot = await jsonFile<Snapshot>(snapshotPath);
  validateSnapshot(snapshot);
  const report = audit(config, snapshot);
  printReport(report);
  await writeHtml(report);
  setReportExitCode(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
