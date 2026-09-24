import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { createDefaultSteps } from "./steps.ts";
import { runWorkflow } from "./workflow.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));

const ticketPath = readArg("--ticket");
const repo = path.resolve(readArg("--repo") ?? process.cwd());
const configPath = path.resolve(readArg("--config") ?? path.join(harnessRoot, "config", "harness.json"));

if (!ticketPath) {
  process.stderr.write("使い方: tsx src/harness/main.ts --ticket fixtures/sample-ticket.md --repo <gitリポジトリ>\n");
  process.exit(1);
}

const config = await loadConfig(configPath);
const result = await runWorkflow({
  repo,
  ticketPath: path.resolve(ticketPath),
  config,
  steps: createDefaultSteps(config),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}
