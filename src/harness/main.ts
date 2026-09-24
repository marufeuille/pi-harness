import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { createDefaultSteps } from "./steps.ts";
import type { OfflineFixture } from "./session.ts";
import { runWorkflow } from "./workflow.ts";
import { loadLinearTicket } from "./ticket.ts";
import { runLinearLifecycle, updateLinearStateResult } from "./linear-lifecycle.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));

const ticketPath = readArg("--ticket");
const linearId = readArg("--linear");
const repo = path.resolve(readArg("--repo") ?? process.cwd());
const configPath = path.resolve(readArg("--config") ?? path.join(harnessRoot, "config", "harness.json"));

if (process.env.HARNESS_E2E_FIXTURE && linearId) {
  process.stderr.write("固定応答実行では Linear 入力を利用できません\n");
  process.exit(1);
}

if (Boolean(ticketPath) === Boolean(linearId)) {
  process.stderr.write("--ticket または --linear のどちらか一方を指定してください\n");
  process.exit(1);
}

let ticket;
if (linearId) {
  try {
    ticket = await loadLinearTicket(linearId);
  } catch (error) {
    process.stderr.write(`Linear の課題を利用できません: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const config = await loadConfig(configPath);
let fixture: OfflineFixture | undefined;
if (process.env.HARNESS_E2E_FIXTURE) {
  if (config.phases.pullRequest || config.phases.requireCi || config.phases.merge || config.phases.productionCheck) {
    throw new Error("固定応答実行では外部フェーズを有効にできません");
  }
  const raw = JSON.parse(await readFile(path.resolve(process.env.HARNESS_E2E_FIXTURE), "utf8")) as { calls?: unknown };
  if (!Array.isArray(raw.calls) || !raw.calls.every((item) => item && typeof item === "object" && typeof item.stage === "string" && typeof item.response === "string")) {
    throw new Error("固定応答フィクスチャの形式が不正です");
  }
  fixture = { calls: raw.calls as OfflineFixture["calls"], index: 0 };
}
const input = {
  repo,
  ...(ticket ? { ticket } : { ticketPath: path.resolve(ticketPath!) }),
  config,
  steps: createDefaultSteps(config, fixture),
};
if (linearId) {
  const outcome = await runLinearLifecycle({
    issueId: linearId,
    updateLinearIssueState: updateLinearStateResult,
    runWorkflow: () => runWorkflow(input),
  });
  if (!outcome.ok) {
    process.stderr.write(`Linear の状態を更新できません: ${outcome.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
} else {
  const result = await runWorkflow(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}
