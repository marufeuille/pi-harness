import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WorkflowConfig } from "./config.ts";
import {
  parseClarification,
  parseJsonBlock,
  parsePlan,
  parseReview,
  type ProductionCheck,
  type PullRequest,
  type JsonReadFailure,
  type Steps,
} from "./contract.ts";
import { runGit } from "./worktrees.ts";
import { runRole, toolsFor } from "./session.ts";
import { maskSecrets } from "./mask.ts";

const execFileAsync = promisify(execFile);

export function createDefaultSteps(config: WorkflowConfig): Steps {
  const smart = config.models.smart;
  const cheap = config.models.cheap;

  return {
    async clarify({ ticket, cwd }) {
      const text = await runRole({
        role: "smart",
        model: smart,
        cwd,
        tools: toolsFor("read"),
        prompt: [
          "次のチケットを読み、実装に入ってよいか判断してください。",
          "見るのは入出力の境界です。実装方法の細かい食い違いは追わなくてよいです。",
          "要件から推測できることは assumptions に書き、進めてください。",
          "境界が曖昧なときだけ return にし、利用者へ返す質問を questions に書いてください。",
          "",
          "JSON だけを ```json ブロックで返してください。",
          '{"decision":"proceed","assumptions":["..."]}',
          "または",
          '{"decision":"return","questions":["..."]}',
          "",
          `タイトル: ${ticket.title}`,
          "",
          ticket.body,
        ].join("\n"),
      });
      const value = readJson(text, "clarify", 1);
      return "decision" in value && value.decision === "json-read-failed" ? value : parseClarification(value);
    },

    async plan({ ticket, assumptions, cwd }) {
      const text = await runRole({
        role: "smart",
        model: smart,
        cwd,
        tools: toolsFor("read"),
        prompt: [
          "チケットを、依存関係のあるタスクに分けてください。",
          "ファイルが重ならないタスクは dependsOn を空にして、同じ wave で並列に走らせます。",
          "依存があるものだけ dependsOn にタスク id を入れてください。",
          "id は英数字で始まる短い名前です。instructions に、そのタスクで満たす境界を書いてください。",
          "細かく切りすぎないでください。",
          "",
          "JSON だけを ```json ブロックで返してください。",
          '{"assumptions":["..."],"tasks":[{"id":"add-greet","title":"...","dependsOn":[],"instructions":"..."}]}',
          "",
          "すでに置いた推測:",
          assumptions.map((item) => `- ${item}`).join("\n") || "(なし)",
          "",
          `タイトル: ${ticket.title}`,
          "",
          ticket.body,
        ].join("\n"),
      });
      const value = readJson(text, "plan", 1);
      return "decision" in value && value.decision === "json-read-failed" ? value : parsePlan(value);
    },

    async implement({ task, worktree, ticket }) {
      await runRole({
        role: "cheap",
        model: cheap,
        cwd: worktree.path,
        tools: toolsFor("edit"),
        prompt: [
          "この作業ツリーで、次のタスクだけを実装してください。",
          "git の操作はしないでください。テストとリンタが通ることを優先してください。",
          "",
          `タスク: ${task.id} ${task.title}`,
          task.instructions,
          "",
          "チケット:",
          `タイトル: ${ticket.title}`,
          "",
          ticket.body,
        ].join("\n"),
      });
    },

    async review({ ticket, plan, attempt, maxLoops, cwd, baseSha }) {
      const text = await runRole({
        role: "smart",
        model: smart,
        cwd,
        tools: toolsFor("read").concat("bash"),
        prompt: [
          "実装がチケットの要求を満たしているか検品してください。",
          `変更は git diff ${baseSha} で見られます。`,
          "直すべきなのは、要求との不一致と重大なセキュリティ上の問題だけです。",
          "記法、わずかな非効率、確率の低い懸念は concerns に残さず捨ててください。",
          `これは ${attempt} 回目で、上限は ${maxLoops} 回です。`,
          "上限に近く、致命的な問題が残っていないなら decision は pass にし、残った懸念だけ concerns に書いてください。",
          "致命的な問題が残るなら decision は fix にし、安いモデルが直せるタスクを issues に書いてください。",
          "このまま人に返すしかないときは decision は escalate にしてください。",
          "",
          "JSON だけを ```json ブロックで返してください。",
          '{"decision":"pass","concerns":[]}',
          "または",
          '{"decision":"fix","issues":[{"id":"fix-boundary","title":"...","dependsOn":[],"instructions":"..."}]}',
          "または",
          '{"decision":"escalate","reason":"..."}',
          "",
          "プランの推測:",
          plan.assumptions.map((item) => `- ${item}`).join("\n") || "(なし)",
          "",
          `タイトル: ${ticket.title}`,
          "",
          ticket.body,
        ].join("\n"),
      });
      const value = readJson(text, "review", attempt);
      return "decision" in value && value.decision === "json-read-failed" ? value : parseReview(value);
    },

    async openPullRequest({ cwd, title, baseBranch, headBranch, assumptions, concerns }) {
      await runGit(cwd, ["push", "-u", "origin", headBranch]);
      const body = [
        "## 推測",
        assumptions.map((item) => `- ${item}`).join("\n") || "(なし)",
        "",
        "## 残した懸念",
        concerns.map((item) => `- ${item}`).join("\n") || "(なし)",
      ].join("\n");
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "create", "--base", baseBranch, "--head", headBranch, "--title", title, "--body", body],
        { cwd, encoding: "utf8" },
      );
      return pullRequestFromUrl(stdout.trim());
    },

    async waitForChecks({ cwd, pullRequest }) {
      await execFileAsync("gh", ["pr", "checks", String(pullRequest.number), "--watch", "--fail-fast"], {
        cwd,
        encoding: "utf8",
      });
    },

    async merge({ cwd, pullRequest }) {
      await execFileAsync("gh", ["pr", "merge", String(pullRequest.number), "--merge"], {
        cwd,
        encoding: "utf8",
      });
    },

    async checkProduction({ cwd, command }) {
      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", command], { cwd, encoding: "utf8" });
        return { decision: "ok", summary: `${stdout}${stderr}`.trim() } satisfies ProductionCheck;
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        const summary = `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`.trim();
        return { decision: "problem", summary };
      }
    },
  };
}

function readJson(text: string, stage: JsonReadFailure["stage"], attempt: number): unknown | JsonReadFailure {
  try {
    return parseJsonBlock(text);
  } catch {
    return { decision: "json-read-failed", stage, attempt, text: maskSecrets(text) };
  }
}

function pullRequestFromUrl(url: string): PullRequest {
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  if (!url.startsWith("http") || !Number.isInteger(number)) {
    throw new Error(`プルリクエストの URL を読めませんでした: ${url}`);
  }
  return { url, number };
}
