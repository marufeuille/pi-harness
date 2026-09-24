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
import { assertResumeAllowed, loadLoopState, resumeActionFrom, type ResumeInput } from "./loop-state.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));

const ticketPath = readArg("--ticket");
const linearId = readArg("--linear");
const resumePath = readArg("--resume");
const baseRevision = readArg("--base");
const extraRoundsRaw = readArg("--extra-rounds");
const hint = readArg("--hint");
const replanRemaining = process.argv.includes("--replan-remaining");
const continueFromIngest = process.argv.includes("--continue-from-ingest");
const answers = readRepeat("--answer");

if (process.argv.filter((arg) => arg === "--base").length > 1 || (process.argv.includes("--base") && (!baseRevision || baseRevision.startsWith("--")))) {
  process.stderr.write("--base には空でないリビジョンを指定してください\n");
  process.exit(1);
}
if (process.argv.filter((arg) => arg === "--resume").length > 1 || (process.argv.includes("--resume") && (!resumePath || resumePath.startsWith("--")))) {
  process.stderr.write("--resume には停止した実行のディレクトリまたは loop-state.json を指定してください\n");
  process.exit(1);
}

const resumeFlags = countResumeFlags({ extraRoundsRaw, hint, replanRemaining, answers, continueFromIngest });
if (resumePath) {
  if (ticketPath) {
    process.stderr.write("--resume と --ticket は同時に指定できません\n");
    process.exit(1);
  }
  if (baseRevision) {
    process.stderr.write("再開では新しい起点を指定できません\n");
    process.exit(1);
  }
  if (resumeFlags !== 1) {
    process.stderr.write("再開の入力は次の一手だけにしてください\n");
    process.exit(1);
  }
} else {
  if (resumeFlags > 0) {
    process.stderr.write("再開の一手は --resume と一緒に指定してください\n");
    process.exit(1);
  }
  if (Boolean(ticketPath) === Boolean(linearId)) {
    process.stderr.write("--ticket または --linear のどちらか一方を指定してください\n");
    process.exit(1);
  }
}

const repo = path.resolve(readArg("--repo") ?? process.cwd());
const configPath = path.resolve(readArg("--config") ?? path.join(harnessRoot, "config", "harness.json"));

if (process.env.HARNESS_E2E_FIXTURE && linearId) {
  process.stderr.write("固定応答実行では Linear 入力を利用できません\n");
  process.exit(1);
}

let resume: ResumeInput | undefined;
if (resumePath) {
  try {
    const state = await loadLoopState(path.resolve(resumePath));
    const extraRounds = extraRoundsRaw === undefined ? undefined : Number(extraRoundsRaw);
    if (extraRoundsRaw !== undefined && (!Number.isInteger(extraRounds) || extraRounds < 1)) {
      throw new Error("追加回数は 1 以上の整数にしてください");
    }
    resume = {
      state,
      ...(extraRounds !== undefined ? { extraRounds } : {}),
      ...(hint !== undefined ? { hint } : {}),
      ...(replanRemaining ? { replanRemaining: true } : {}),
      ...(answers.length > 0 ? { answers } : {}),
      ...(continueFromIngest ? { continueFromIngest: true } : {}),
    };
    assertResumeAllowed(state.stopKind, resumeActionFrom(resume));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
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
if (linearId && !resume) {
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
  if (!Array.isArray(raw.calls) || !raw.calls.every((item) => isFixtureCall(item))) {
    throw new Error("固定応答フィクスチャの形式が不正です");
  }
  fixture = { calls: raw.calls as OfflineFixture["calls"], index: 0 };
}
const input = {
  repo,
  ...(ticket ? { ticket } : ticketPath ? { ticketPath: path.resolve(ticketPath) } : {}),
  config,
  steps: createDefaultSteps(config, fixture),
  ...(baseRevision ? { baseRevision } : {}),
  ...(resume ? { resume } : {}),
} as Parameters<typeof runWorkflow>[0] & { baseRevision?: string };
if (linearId) {
  const outcome = await runLinearLifecycle({
    issueId: linearId,
    updateLinearIssueState: updateLinearStateResult,
    resume: Boolean(resume),
    runWorkflow: () => runWorkflow(input).catch((error) => {
      process.stderr.write(`${resume ? "" : "起点を解決できません: "}${error instanceof Error ? error.message : String(error)}\n`);
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
    process.stderr.write(`${resume ? "" : "起点を解決できません: "}${error instanceof Error ? error.message : String(error)}\n`);
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

function readRepeat(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    values.push(value && !value.startsWith("--") ? value : "");
  }
  return values;
}

function countResumeFlags(flags: {
  extraRoundsRaw: string | undefined;
  hint: string | undefined;
  replanRemaining: boolean;
  answers: string[];
  continueFromIngest: boolean;
}): number {
  return [
    flags.extraRoundsRaw !== undefined,
    flags.hint !== undefined,
    flags.replanRemaining,
    flags.answers.length > 0,
    flags.continueFromIngest,
  ].filter(Boolean).length;
}

function isFixtureCall(item: unknown): item is OfflineFixture["calls"][number] {
  if (!item || typeof item !== "object") return false;
  const call = item as Record<string, unknown>;
  if (typeof call.stage !== "string" || typeof call.text !== "string") return false;
  if (call.checkout !== undefined && typeof call.checkout !== "string") return false;
  if (call.writes === undefined) return true;
  return Array.isArray(call.writes) && call.writes.every((write) => write && typeof write === "object" && typeof (write as { path?: unknown }).path === "string" && typeof (write as { content?: unknown }).content === "string");
}
