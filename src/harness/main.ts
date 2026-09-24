import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { createDefaultSteps } from "./steps.ts";
import type { OfflineFixture } from "./session.ts";
import { runWorkflow } from "./workflow.ts";
import { loadLinearTicket } from "./ticket.ts";
import { runLinearLifecycle, updateLinearStateResult } from "./linear-lifecycle.ts";
import { validateCursorModels } from "./cursor-preflight.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));

const ticketPath = readArg("--ticket");
const linearId = readArg("--linear");
const baseRevision = readArg("--base");
if (process.argv.filter((arg) => arg === "--base").length > 1 || (process.argv.includes("--base") && (!baseRevision || baseRevision.startsWith("--")))) {
  process.stderr.write("--base には空でないリビジョンを指定してください\n");
  process.exit(1);
}
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

const config = await loadConfig(configPath);
// 固定応答はモデルを呼ばない。Cursor の認証とモデル一覧は確認しない。
if (!process.env.HARNESS_E2E_FIXTURE) {
  try {
    await validateCursorModels(config);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
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

let fixture: OfflineFixture | undefined;
if (process.env.HARNESS_E2E_FIXTURE) {
  if (config.phases.pullRequest || config.phases.requireCi || config.phases.merge || config.phases.productionCheck) {
    throw new Error("固定応答実行では外部フェーズを有効にできません");
  }
  const raw = JSON.parse(await readFile(path.resolve(process.env.HARNESS_E2E_FIXTURE), "utf8")) as { calls?: unknown };
  if (!Array.isArray(raw.calls) || !raw.calls.every((item) => item && typeof item === "object" && typeof item.stage === "string" && typeof item.text === "string" && (item.writes === undefined || (Array.isArray(item.writes) && item.writes.every((write) => write && typeof write === "object" && typeof write.path === "string" && typeof write.content === "string"))))) {
    throw new Error("固定応答フィクスチャの形式が不正です");
  }
  fixture = { calls: raw.calls as OfflineFixture["calls"], index: 0 };
}
const input = {
  repo,
  ...(ticket ? { ticket } : { ticketPath: path.resolve(ticketPath!) }),
  config,
  steps: createDefaultSteps(config, fixture),
  ...(baseRevision ? { baseRevision } : {}),
} as Parameters<typeof runWorkflow>[0] & { baseRevision?: string };
if (linearId) {
  const outcome = await runLinearLifecycle({
    issueId: linearId,
    updateLinearIssueState: updateLinearStateResult,
    runWorkflow: () => runWorkflow(input).catch((error) => {
      process.stderr.write(`起点を解決できません: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }),
  });
  if (!outcome.ok) {
    process.stderr.write(`Linear の状態を更新できません: ${outcome.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
} else {
  let result;
  try {
    result = await runWorkflow(input);
  } catch (error) {
    process.stderr.write(`起点を解決できません: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}
