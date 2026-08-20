#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { audit } from "./audit.ts";
import { render } from "./render.ts";
import { queryPlan } from "./sql.ts";
import type { Config, Snapshot } from "./types.ts";
import { validateConfig, validateSnapshot } from "./validate.ts";

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
  if (!configPath || !["audit", "plan"].includes(command)) {
    console.error("Usage:\n  flowproof audit --config flowproof.json --snapshot snapshot.json [--json]\n  flowproof plan --config flowproof.json");
    process.exitCode = 2;
    return;
  }
  const config = await jsonFile<Config>(configPath);
  validateConfig(config);
  if (command === "plan") {
    console.log(queryPlan(config));
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
