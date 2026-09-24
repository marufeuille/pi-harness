import path from "node:path";

import { runChecks } from "./checks.ts";
import type { WorkflowConfig } from "./config.ts";
import type { Plan, PullRequest, Steps, Task, Ticket } from "./contract.ts";
import { archiveProfilerLogs } from "./observability.ts";
import { schedule } from "./schedule.ts";
import { loadTicket } from "./ticket.ts";
import {
  commitsAhead,
  commitAll,
  createRunId,
  currentBranch,
  ensureGitRepo,
  headSha,
  mergeBranch,
  openIntegrationWorktree,
  openTaskWorktree,
  removeWorktree,
  runDirectory,
  runGit,
  type Worktree,
} from "./worktrees.ts";

export type WorkflowInput = {
  repo: string;
  ticketPath?: string;
  ticket?: Ticket;
  config: WorkflowConfig;
  steps: Steps;
};

type Outcome =
  | { status: "returned"; questions: string[] }
  | { status: "escalated"; reason: string }
  | { status: "ready"; assumptions: string[]; concerns: string[]; pullRequest?: PullRequest }
  | { status: "production-ok"; summary: string; assumptions: string[]; concerns: string[] }
  | { status: "production-failed"; summary: string };

export type JsonReadFailure = { stage: string; attempt: number; text: string };

export type WorkflowResult = Outcome & {
  jsonReadFailures: JsonReadFailure[];
  runId: string;
  runDir: string;
  integrationPath?: string;
};

type Run = {
  repo: string;
  runId: string;
  runDir: string;
  startedAt: number;
  baseBranch: string;
  baseSha: string;
  config: WorkflowConfig;
  steps: Steps;
  integration?: Worktree;
  jsonReadFailures: JsonReadFailure[];
};

export async function runWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  const ticket = input.ticket ?? (input.ticketPath ? await loadTicket(input.ticketPath) : undefined);
  if (!ticket) throw new Error("チケット入力がありません");
  const run = beginRun(input);

  phase("要件を確認する");
  let clarification;
  try {
    clarification = await input.steps.clarify({ ticket, cwd: input.repo });
  } catch (error) {
    if (!recordJsonFailure(run, error, "clarify", 1)) throw error;
    await keepLogs(run, "clarify", input.repo);
    return finish(run, { status: "returned", questions: ["要件確認の返答から JSON を読み取れませんでした"] });
  }
  await keepLogs(run, "clarify", input.repo);
  if (clarification.decision === "return") {
    return finish(run, { status: "returned", questions: clarification.questions });
  }

  run.baseBranch = await ensureGitRepo(input.repo);
  if (input.config.phases.pullRequest && run.baseBranch === "HEAD") {
    throw new Error("プルリクエストを作るには、ブランチにチェックアウトした git リポジトリが必要です");
  }

  phase("プランを作る");
  let plan;
  try {
    plan = await input.steps.plan({ ticket, assumptions: clarification.assumptions, cwd: input.repo });
  } catch (error) {
    if (!recordJsonFailure(run, error, "plan", 1)) throw error;
    await keepLogs(run, "plan", input.repo);
    return finish(run, { status: "returned", questions: ["プランの返答から JSON を読み取れませんでした"] });
  }
  await keepLogs(run, "plan", input.repo);

  run.integration = await openIntegrationWorktree(input.repo, run.runId);
  run.baseSha = await headSha(run.integration.path);

  const implemented = await implementTasks(run, ticket, plan.tasks);
  if (implemented.status === "escalated") {
    return finish(run, implemented);
  }

  const review = await reviewUntilAcceptable(run, ticket, plan);
  if (review.decision === "escalate") {
    return finish(run, { status: "escalated", reason: review.reason });
  }

  const assumptions = [...clarification.assumptions, ...plan.assumptions];
  if (!input.config.phases.pullRequest) {
    return finish(run, { status: "ready", assumptions, concerns: review.concerns });
  }

  phase("プルリクエストを作る");
  const pullRequest = await input.steps.openPullRequest({
    cwd: run.integration.path,
    title: ticket.title,
    baseBranch: run.baseBranch,
    headBranch: run.integration.branch,
    assumptions,
    concerns: review.concerns,
  });

  if (input.config.phases.requireCi) {
    phase("CI を待つ");
    await input.steps.waitForChecks({ cwd: run.integration.path, pullRequest });
  }

  if (!input.config.phases.merge) {
    return finish(run, { status: "ready", assumptions, concerns: review.concerns, pullRequest });
  }

  phase("マージする");
  await input.steps.merge({ cwd: run.integration.path, pullRequest });

  if (!input.config.phases.productionCheck) {
    return finish(run, { status: "ready", assumptions, concerns: review.concerns, pullRequest });
  }

  phase("本番を確認する");
  const production = await input.steps.checkProduction({
    cwd: input.repo,
    pullRequest,
    command: input.config.productionCheckCommand ?? "",
  });
  if (production.decision === "problem") {
    return finish(run, { status: "production-failed", summary: production.summary });
  }
  return finish(run, {
    status: "production-ok",
    summary: production.summary,
    assumptions,
    concerns: review.concerns,
  });
}

async function implementTasks(
  run: Run,
  ticket: Ticket,
  tasks: Task[],
): Promise<{ status: "implemented" } | { status: "escalated"; reason: string }> {
  const waves = schedule(tasks);
  for (const [index, wave] of waves.entries()) {
    phase(`実装する ${index + 1}/${waves.length}: ${wave.map((task) => task.id).join(", ")}`);
    const prepared: Array<{ task: Task; worktree: Worktree }> = [];
    for (const task of wave) {
      prepared.push({
        task,
        worktree: await openTaskWorktree(run.repo, run.runId, task.id, integration(run).branch),
      });
    }

    const outcomes = await Promise.all(
      prepared.map(async ({ task, worktree }) => {
        await run.steps.implement({ task, worktree, ticket });
        await keepLogs(run, task.id, worktree.path);
        const branch = await currentBranch(worktree.path);
        if (branch !== worktree.branch) {
          return {
            ok: false as const,
            reason: `${task.id} の作業ツリーがブランチ ${worktree.branch} から外れました`,
          };
        }
        await commitAll(worktree.path, `harness: ${task.id} ${task.title}`);
        return { ok: true as const, task, worktree };
      }),
    );

    for (const outcome of outcomes) {
      if (!outcome.ok) {
        return { status: "escalated", reason: outcome.reason };
      }
      const ahead = await commitsAhead(outcome.worktree.path, integration(run).branch, outcome.worktree.branch);
      if (ahead === 0) {
        await removeTask(run, outcome.worktree);
        continue;
      }
      const merged = await mergeBranch(integration(run), outcome.worktree.branch);
      if (!merged.ok) {
        return {
          status: "escalated",
          reason: `${outcome.task.id} の取り込みで衝突しました\n${merged.reason}`,
        };
      }
      await removeTask(run, outcome.worktree);
    }
  }

  return { status: "implemented" };
}

async function reviewUntilAcceptable(
  run: Run,
  ticket: Ticket,
  plan: Plan,
): Promise<{ decision: "pass"; concerns: string[] } | { decision: "escalate"; reason: string }> {
  const maxLoops = run.config.review.maxLoops;

  for (let attempt = 1; attempt <= maxLoops; attempt += 1) {
    const checks = await runChecks(integration(run).path, run.config.checks);
    if (!checks.ok) {
      phase(`チェックが失敗した ${attempt}/${maxLoops}`);
      if (attempt === maxLoops) {
        return {
          decision: "escalate",
          reason: `チェックが上限まで失敗しました\n${checks.output}`,
        };
      }
      const fixed = await implementTasks(run, ticket, [
        {
          id: `checks-${attempt}`,
          title: "失敗したチェックを直す",
          dependsOn: [],
          instructions: checks.output,
        },
      ]);
      if (fixed.status === "escalated") {
        return { decision: "escalate", reason: fixed.reason };
      }
      continue;
    }

    phase(`検品する ${attempt}/${maxLoops}`);
    let review;
    try {
      review = await run.steps.review({ ticket, plan, attempt, maxLoops, cwd: integration(run).path, baseSha: run.baseSha });
    } catch (error) {
      if (!recordJsonFailure(run, error, "review", attempt)) throw error;
      await keepLogs(run, `review-${attempt}`, integration(run).path);
      if (attempt === maxLoops) return { decision: "escalate", reason: "修正ループの上限に達したため、人に戻します" };
      continue;
    }
    await keepLogs(run, `review-${attempt}`, integration(run).path);
    if (review.decision === "pass" || review.decision === "escalate") {
      return review;
    }
    if (attempt === maxLoops) {
      return { decision: "escalate", reason: "修正ループの上限に達したため、人に戻します" };
    }

    phase(`検品の指摘を直す ${attempt}/${maxLoops}`);
    const fixed = await implementTasks(run, ticket, review.issues);
    if (fixed.status === "escalated") {
      return { decision: "escalate", reason: fixed.reason };
    }
  }

  return { decision: "escalate", reason: "修正ループの上限に達したため、人に戻します" };
}

function beginRun(input: WorkflowInput): Run {
  const runId = createRunId();
  return {
    repo: input.repo,
    runId,
    runDir: runDirectory(input.repo, runId),
    startedAt: Date.now(),
    baseBranch: "",
    baseSha: "",
    config: input.config,
    steps: input.steps,
    jsonReadFailures: [],
  };
}

async function removeTask(run: Run, worktree: Worktree): Promise<void> {
  await removeWorktree(run.repo, worktree.path);
  await runGit(run.repo, ["branch", "-D", worktree.branch]);
}

function integration(run: Run): Worktree {
  if (!run.integration) {
    throw new Error("統合用の worktree がまだありません");
  }
  return run.integration;
}

async function keepLogs(run: Run, label: string, cwd: string): Promise<void> {
  await archiveProfilerLogs(cwd, path.join(run.runDir, "observability", label), run.startedAt);
}

function recordJsonFailure(run: Run, error: unknown, stage: string, attempt: number): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; text?: unknown; rawText?: unknown; stage?: unknown; attempt?: unknown };
  if (candidate.name !== "JsonReadFailure" && typeof candidate.text !== "string" && typeof candidate.rawText !== "string") return false;
  const text = typeof candidate.text === "string" ? candidate.text : typeof candidate.rawText === "string" ? candidate.rawText : "";
  run.jsonReadFailures.push({ stage: typeof candidate.stage === "string" ? candidate.stage : stage, attempt: typeof candidate.attempt === "number" ? candidate.attempt : attempt, text: maskSecrets(text) });
  return true;
}

function maskSecrets(text: string): string {
  return text.replace(/(?:api[_-]?key|token|secret|password)(\\s*[:=]\\s*)([\\"']?)[^\\s,\\"'}`]+/gi, "$1$2[REDACTED]");
}

function finish(run: Run, result: Outcome): WorkflowResult {
  return {
    ...result,
    runId: run.runId,
    runDir: run.runDir,
    integrationPath: run.integration?.path,
    jsonReadFailures: run.jsonReadFailures,
  };
}

function phase(message: string): void {
  process.stderr.write(`[harness] ${message}\n`);
}
