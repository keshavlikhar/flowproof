#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { audit } from "./audit.ts";
import { render } from "./render.ts";
import { queryPlan } from "./sql.ts";
import type { Config, Snapshot } from "./types.ts";
import { validateConfig, validateSnapshot } from "./validate.ts";
import { collectSnapshot } from "./collect.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const configPath = argument("--config");
  if (!configPath || !["audit", "plan", "verify"].includes(command)) {
    console.error("Usage:\n  flowproof audit --config flowproof.json --snapshot snapshot.json [--json]\n  flowproof plan --config flowproof.json\n  flowproof verify --config flowproof.json --since <ISO> --until <ISO> [--json] [--save-snapshot path]");
    process.exitCode = 2;
    return;
  }
  const config = await jsonFile<Config>(configPath);
  validateConfig(config);
  if (command === "plan") {
    console.log(queryPlan(config));
    return;
  }
  if (command === "verify") {
    const since = argument("--since");
    const until = argument("--until");
    if (!since || !until) throw new Error("verify requires an explicit closed window: --since <ISO> --until <ISO>");
    const { liveClients } = await import("./clients.ts");
    const clients = liveClients();
    let snapshot: Snapshot;
    try {
      snapshot = await collectSnapshot(config, clients, { since, until });
    } finally {
      await Promise.allSettled([clients.postgres.close(), clients.snowflake.close()]);
    }
    const savePath = argument("--save-snapshot");
    if (savePath) {
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
    const report = audit(config, snapshot);
    console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report));
    process.exitCode = report.overall === "fail" ? 1 : report.overall === "unknown" ? 2 : 0;
    return;
  }
  const snapshotPath = argument("--snapshot");
  if (!snapshotPath) throw new Error("audit requires --snapshot");
  const snapshot = await jsonFile<Snapshot>(snapshotPath);
  validateSnapshot(snapshot);
  const report = audit(config, snapshot);
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report));
  process.exitCode = report.overall === "fail" ? 1 : report.overall === "unknown" ? 2 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
