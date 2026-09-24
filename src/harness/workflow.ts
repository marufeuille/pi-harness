import { access } from "node:fs/promises";
import path from "node:path";

import { runChecks } from "./checks.ts";
import type { WorkflowConfig } from "./config.ts";
import type { Plan, PullRequest, Steps, Task, Ticket } from "./contract.ts";
import {
  applyAnswers,
  applyHint,
  assertResumeAllowed,
  readyTasks,
  resumeActionFrom,
  saveLoopState,
  type LoopState,
  type ResumeAction,
  type ResumeInput,
  type TaskPlan,
} from "./loop-state.ts";
import {
  checkFixTask,
  classifyCheckTrend,
  classifyIssueTrend,
  formatIssues,
  isEnvironmentCheckFailure,
  kindForIssueLimit,
  makeStopSnapshot,
  type LoopRound,
  type LoopTrend,
  type StopKind,
  type StopSnapshot,
} from "./loop-stop.ts";
import { archiveProfilerLogs, profilerLogFiles } from "./observability.ts";
import { schedule } from "./schedule.ts";
import { maskSecrets } from "./mask.ts";
import { loadTicket } from "./ticket.ts";
import {
  commitsAhead,
  commitAll,
  createRunId,
  currentBranch,
  ensureGitRepo,
  mergeBranch,
  openIntegrationWorktree,
  openTaskWorktree,
  removeWorktree,
  runDirectory,
  runGit,
  resolveBase,
  publishBaseBranch,
  type Worktree,
} from "./worktrees.ts";

export type WorkflowInput = {
  repo: string;
  ticketPath?: string;
  ticket?: Ticket;
  config: WorkflowConfig;
  steps: Steps;
  baseRevision?: string;
  resume?: ResumeInput;
};

type StoppedOutcome = {
  status: "escalated";
  reason: string;
  stop: StopSnapshot;
  resumeState: LoopState;
};

type ReturnedOutcome = {
  status: "returned";
  questions: string[];
  stop?: StopSnapshot;
  resumeState?: LoopState;
};

type Outcome =
  | ReturnedOutcome
  | StoppedOutcome
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
  baseBranch: string;
  baseSha: string;
  config: WorkflowConfig;
  steps: Steps;
  integration?: Worktree;
  jsonReadFailures: JsonReadFailure[];
  ticket?: Ticket;
  plan?: TaskPlan;
  assumptions: string[];
  remaining: Task[];
  remainingTasks: Task[];
  ingestPosition: number;
  completedTaskIds: string[];
  history: LoopRound[];
  originalMaxLoops: number;
  loopBudget: number;
  shouldPublishBase: boolean;
};

export async function runWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  const ticket = input.resume?.state.ticket ?? input.ticket ?? (input.ticketPath ? await loadTicket(input.ticketPath) : undefined);
  if (!ticket) throw new Error("チケット入力がありません");
  await ensureGitRepo(input.repo);

  if (input.resume) {
    return continueFromState(input, ticket);
  }

  const run = beginRun(input);
  run.ticket = ticket;
  const base = await resolveBase(input.repo, input.baseRevision);
  run.baseBranch = input.baseRevision ? `harness/${run.runId}/base` : base.branch;
  run.baseSha = base.sha;

  phase("要件を確認する");
  let clarification;
  const clarifyLogs = await profilerLogFiles(input.repo);
  clarification = await input.steps.clarify({ ticket, cwd: input.repo });
  await keepLogs(run, "clarify", input.repo, clarifyLogs);
  if ("decision" in clarification && clarification.decision === "json-read-failed") {
    recordJsonFailure(run, clarification);
    return finish(run, { status: "returned", questions: ["要件確認の返答から JSON を読み取れませんでした"] });
  }
  if (clarification.decision === "return") {
    return finish(run, { status: "returned", questions: clarification.questions });
  }
  run.assumptions = clarification.assumptions;

  phase("プランを作る");
  let plan;
  const planLogs = await profilerLogFiles(input.repo);
  plan = await input.steps.plan({ ticket, assumptions: clarification.assumptions, cwd: input.repo });
  await keepLogs(run, "plan", input.repo, planLogs);
  if ("decision" in plan && plan.decision === "json-read-failed") {
    recordJsonFailure(run, plan);
    return finish(run, { status: "returned", questions: ["プランの返答から JSON を読み取れませんでした"] });
  }
  run.plan = plan;
  run.assumptions = [...clarification.assumptions, ...plan.assumptions];
  run.shouldPublishBase = Boolean(input.baseRevision);

  run.integration = await openIntegrationWorktree(input.repo, run.runId, run.baseSha);

  const implemented = await implementTasks(run, ticket, plan.tasks);
  if (implemented.status === "stopped") {
    return finish(run, stoppedOutcome(run, implemented.kind, implemented.lastOutput, "same"));
  }

  return afterImplementation(run, ticket, plan);
}

async function continueFromState(input: WorkflowInput, ticket: Ticket): Promise<WorkflowResult> {
  const resume = input.resume!;
  const action = resumeActionFrom(resume);
  assertResumeAllowed(resume.state.stopKind, action);
  const run = resumeRun(input, resume.state, action);
  run.ticket = ticket;
  await access(resume.state.integrationPath);

  let state = resume.state;
  if ("hint" in action) {
    state = applyHint(state, action.hint);
    run.remaining = state.remaining;
    run.remainingTasks = state.remainingTasks;
    run.assumptions = state.assumptions;
  }
  if ("answers" in action) {
    state = applyAnswers(state, action.answers);
    run.assumptions = state.assumptions;
    if (run.plan) {
      run.plan = { ...run.plan, assumptions: [...run.plan.assumptions, ...action.answers] };
    }
  }

  if ("replanRemaining" in action) {
    phase("残件だけプランを作り直す");
    const planLogs = await profilerLogFiles(integration(run).path);
    const remaining = state.remaining.length > 0 ? state.remaining : state.remainingTasks;
    const plan = await input.steps.plan({
      ticket,
      assumptions: run.assumptions,
      cwd: integration(run).path,
      remaining,
    });
    await keepLogs(run, "plan-remaining", integration(run).path, planLogs);
    if ("decision" in plan && plan.decision === "json-read-failed") {
      recordJsonFailure(run, plan);
      return finish(run, { status: "returned", questions: ["プランの返答から JSON を読み取れませんでした"] });
    }
    run.assumptions = [...run.assumptions, ...plan.assumptions];
    run.plan = {
      assumptions: [...(run.plan?.assumptions ?? []), ...plan.assumptions],
      tasks: [...(run.plan?.tasks.filter((task) => run.completedTaskIds.includes(task.id)) ?? []), ...plan.tasks],
    };
    run.remaining = plan.tasks;
  }

  const pending = action.continueFromIngest
    ? readyTasks(run.remainingTasks, new Set(run.completedTaskIds))
    : run.remaining;
  if (pending.length > 0) {
    const implemented = await implementTasks(run, ticket, pending);
    if (implemented.status === "stopped") {
      return finish(run, stoppedOutcome(run, implemented.kind, implemented.lastOutput, "same"));
    }
    run.remaining = [];
  }

  const plan = run.plan;
  if (!plan) throw new Error("再開するプランがありません");
  return afterImplementation(run, ticket, plan);
}

async function afterImplementation(run: Run, ticket: Ticket, plan: TaskPlan): Promise<WorkflowResult> {
  const review = await reviewUntilAcceptable(run, ticket, plan);
  if (review.status === "stop") {
    return finish(run, review.outcome);
  }

  const assumptions = run.assumptions;
  if (!run.config.phases.pullRequest) {
    return finish(run, { status: "ready", assumptions, concerns: review.concerns });
  }

  phase("プルリクエストを作る");
  if (run.shouldPublishBase) await publishBaseBranch(run.repo, run.baseBranch, run.baseSha);
  const pullRequest = await run.steps.openPullRequest({
    cwd: integration(run).path,
    title: ticket.title,
    baseBranch: run.baseBranch,
    headBranch: integration(run).branch,
    assumptions,
    concerns: review.concerns,
  });

  if (run.config.phases.requireCi) {
    phase("CI を待つ");
    await run.steps.waitForChecks({ cwd: integration(run).path, pullRequest });
  }

  if (!run.config.phases.merge) {
    return finish(run, { status: "ready", assumptions, concerns: review.concerns, pullRequest });
  }

  phase("マージする");
  await run.steps.merge({ cwd: integration(run).path, pullRequest });

  if (!run.config.phases.productionCheck) {
    return finish(run, { status: "ready", assumptions, concerns: review.concerns, pullRequest });
  }

  phase("本番を確認する");
  const production = await run.steps.checkProduction({
    cwd: run.repo,
    pullRequest,
    command: run.config.productionCheckCommand ?? "",
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
): Promise<{ status: "implemented" } | { status: "stopped"; kind: "conflict" | "branch-deviation"; lastOutput: string }> {
  const pending = readyTasks(tasks, new Set(run.completedTaskIds));
  if (pending.length === 0) {
    return { status: "implemented" };
  }
  const waves = schedule(pending);
  const mergedIds = new Set<string>();
  const leftover = () => pending.filter((task) => !mergedIds.has(task.id));

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
        const logsBefore = await profilerLogFiles(worktree.path);
        await run.steps.implement({ task, worktree, ticket });
        await keepLogs(run, task.id, worktree.path, logsBefore);
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
        run.remainingTasks = leftover();
        run.remaining = leftover();
        return { status: "stopped", kind: "branch-deviation", lastOutput: outcome.reason };
      }
      const ahead = await commitsAhead(outcome.worktree.path, integration(run).branch, outcome.worktree.branch);
      if (ahead === 0) {
        await removeTask(run, outcome.worktree);
        mergedIds.add(outcome.task.id);
        if (isPlanTask(run, outcome.task.id)) {
          run.completedTaskIds.push(outcome.task.id);
          run.ingestPosition = run.completedTaskIds.length;
        }
        continue;
      }
      const merged = await mergeBranch(integration(run), outcome.worktree.branch);
      if (!merged.ok) {
        run.remainingTasks = leftover();
        run.remaining = leftover();
        return {
          status: "stopped",
          kind: "conflict",
          lastOutput: `${outcome.task.id} の取り込みで衝突しました\n${merged.reason}`,
        };
      }
      await removeTask(run, outcome.worktree);
      mergedIds.add(outcome.task.id);
      if (isPlanTask(run, outcome.task.id)) {
        run.completedTaskIds.push(outcome.task.id);
        run.ingestPosition = run.completedTaskIds.length;
      }
    }
  }

  return { status: "implemented" };
}

async function reviewUntilAcceptable(
  run: Run,
  ticket: Ticket,
  plan: Plan,
): Promise<{ status: "pass"; concerns: string[] } | { status: "stop"; outcome: StoppedOutcome | ReturnedOutcome }> {
  const budget = run.loopBudget;

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    const displayAttempt = run.history.length + 1;
    const cap = displayAttempt + (budget - attempt);
    const checks = await runChecks(integration(run).path, run.config.checks);
    if (!checks.ok) {
      phase(`チェックが失敗した ${displayAttempt}/${cap}`);
      run.history.push({ attempt: displayAttempt, checkOutput: checks.output });
      run.remaining = [checkFixTask(displayAttempt, checks.output)];
      if (isEnvironmentCheckFailure(checks.output)) {
        return { status: "stop", outcome: stoppedOutcome(run, "environment-check", checks.output, "same") };
      }
      const checkTrend = classifyCheckTrend(run.history);
      if (checkTrend === "same") {
        return { status: "stop", outcome: stoppedOutcome(run, "stalled", checks.output, "same") };
      }
      if (attempt === budget) {
        return reviewFailedChecksAtLimit(run, ticket, plan, displayAttempt, cap, checks.output, checkTrend);
      }
      const fixed = await implementTasks(run, ticket, run.remaining);
      if (fixed.status === "stopped") {
        return { status: "stop", outcome: stoppedOutcome(run, fixed.kind, fixed.lastOutput, "same") };
      }
      continue;
    }

    phase(`検品する ${displayAttempt}/${cap}`);
    const reviewed = await runReview(run, ticket, plan, displayAttempt, cap);
    if (reviewed.status === "stop") {
      return reviewed;
    }
    if (reviewed.status === "retry") {
      if (attempt === budget) {
        const trend = classifyIssueTrend(run.history);
        return { status: "stop", outcome: stoppedOutcome(run, kindForIssueLimit(trend), lastOutputFrom(run) || "検品の JSON を読み取れませんでした", trend) };
      }
      continue;
    }
    if (reviewed.status === "pass") {
      return reviewed;
    }
    if (reviewed.status === "fix") {
      const trend = classifyIssueTrend(run.history);
      if (trend === "same") {
        return { status: "stop", outcome: stoppedOutcome(run, "stalled", formatIssues(reviewed.issues), "same") };
      }
      if (attempt === budget) {
        const kind = kindForIssueLimit(trend);
        return { status: "stop", outcome: stoppedOutcome(run, kind, formatIssues(reviewed.issues), trend) };
      }
      phase(`検品の指摘を直す ${displayAttempt}/${cap}`);
      const fixed = await implementTasks(run, ticket, reviewed.issues);
      if (fixed.status === "stopped") {
        return { status: "stop", outcome: stoppedOutcome(run, fixed.kind, fixed.lastOutput, "same") };
      }
    }
  }

  const last = lastOutputFrom(run);
  return { status: "stop", outcome: stoppedOutcome(run, "decreasing-fatal", last, classifyIssueTrend(run.history)) };
}

async function reviewFailedChecksAtLimit(
  run: Run,
  ticket: Ticket,
  plan: Plan,
  attempt: number,
  maxLoops: number,
  checkOutput: string,
  trend: LoopTrend,
): Promise<{ status: "pass"; concerns: string[] } | { status: "stop"; outcome: StoppedOutcome | ReturnedOutcome }> {
  phase(`検品する ${attempt}/${maxLoops}`);
  const reviewed = await runReview(run, ticket, plan, attempt, maxLoops);
  if (reviewed.status === "stop") {
    return reviewed;
  }
  if (reviewed.status === "pass") {
    const concerns = reviewed.concerns.includes(checkOutput) ? reviewed.concerns : [...reviewed.concerns, checkOutput];
    return { status: "pass", concerns };
  }
  return { status: "stop", outcome: stoppedOutcome(run, "changing", checkOutput, trend) };
}

async function runReview(
  run: Run,
  ticket: Ticket,
  plan: Plan,
  attempt: number,
  maxLoops: number,
): Promise<
  | { status: "pass"; concerns: string[] }
  | { status: "fix"; issues: Task[] }
  | { status: "retry" }
  | { status: "stop"; outcome: StoppedOutcome | ReturnedOutcome }
> {
  let review;
  const reviewLogs = await profilerLogFiles(integration(run).path);
  review = await run.steps.review({
    ticket,
    plan: { assumptions: run.assumptions, tasks: run.plan?.tasks ?? ("tasks" in plan ? plan.tasks : []) },
    attempt,
    maxLoops,
    cwd: integration(run).path,
    baseSha: run.baseSha,
  });
  await keepLogs(run, `review-${attempt}`, integration(run).path, reviewLogs);
  if (review.decision === "json-read-failed") {
    recordJsonFailure(run, review);
    return { status: "retry" };
  }
  if (review.decision === "return") {
    return {
      status: "stop",
      outcome: returnedOutcome(run, review.questions, lastOutputFrom(run) || review.questions.join("\n")),
    };
  }
  if (review.decision === "escalate") {
    return { status: "stop", outcome: stoppedOutcome(run, "stalled", review.reason, classifyIssueTrend(run.history)) };
  }
  if (review.decision === "pass") {
    return { status: "pass", concerns: review.concerns };
  }
  run.history.push({ attempt, issues: review.issues });
  run.remaining = review.issues;
  return { status: "fix", issues: review.issues };
}

function beginRun(input: WorkflowInput): Run {
  const runId = createRunId();
  return {
    repo: input.repo,
    runId,
    runDir: runDirectory(input.repo, runId),
    baseBranch: "",
    baseSha: "",
    config: input.config,
    steps: input.steps,
    jsonReadFailures: [],
    assumptions: [],
    remaining: [],
    remainingTasks: [],
    ingestPosition: 0,
    completedTaskIds: [],
    history: [],
    originalMaxLoops: input.config.review.maxLoops,
    loopBudget: input.config.review.maxLoops,
    shouldPublishBase: false,
  };
}

function resumeRun(input: WorkflowInput, state: LoopState, action: ResumeAction): Run {
  return {
    repo: input.repo,
    runId: state.runId,
    runDir: state.runDir,
    baseBranch: state.baseBranch,
    baseSha: state.baseSha,
    config: input.config,
    steps: input.steps,
    integration: { path: state.integrationPath, branch: state.integrationBranch },
    jsonReadFailures: [],
    ticket: state.ticket,
    plan: state.plan,
    assumptions: state.assumptions,
    remaining: state.remaining,
    remainingTasks: state.remainingTasks,
    ingestPosition: state.ingestPosition,
    completedTaskIds: [...state.completedTaskIds],
    history: [...state.history],
    originalMaxLoops: state.originalMaxLoops,
    loopBudget: "extraRounds" in action ? action.extraRounds : state.originalMaxLoops,
    shouldPublishBase: false,
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

async function keepLogs(run: Run, label: string, cwd: string, before: ReadonlySet<string>): Promise<void> {
  await archiveProfilerLogs(cwd, path.join(run.runDir, "observability", label), before);
}

function recordJsonFailure(run: Run, failure: import("./contract.ts").JsonReadFailure): void {
  run.jsonReadFailures.push({ stage: failure.stage, attempt: failure.attempt, text: maskSecrets(failure.text) });
}

async function finish(run: Run, result: Outcome): Promise<WorkflowResult> {
  if ("resumeState" in result && result.resumeState) {
    await saveLoopState(run.runDir, result.resumeState);
  }
  return {
    ...result,
    runId: run.runId,
    runDir: run.runDir,
    integrationPath: run.integration?.path,
    jsonReadFailures: run.jsonReadFailures,
  };
}

function stoppedOutcome(run: Run, kind: StopKind, lastOutput: string, trend: LoopTrend): StoppedOutcome {
  const stop = snapshot(run, kind, lastOutput, trend);
  return {
    status: "escalated",
    reason: lastOutput,
    stop,
    resumeState: captureState(run, kind),
  };
}

function returnedOutcome(run: Run, questions: string[], lastOutput: string): ReturnedOutcome {
  const stop = snapshot(run, "insufficient-requirements", lastOutput, classifyIssueTrend(run.history));
  return {
    status: "returned",
    questions,
    stop,
    resumeState: captureState(run, "insufficient-requirements"),
  };
}

function snapshot(run: Run, kind: StopKind, lastOutput: string, trend: LoopTrend): StopSnapshot {
  const wt = integration(run);
  return makeStopSnapshot({
    kind,
    lastOutput,
    trend,
    branch: wt.branch,
    worktree: wt.path,
  });
}

function captureState(run: Run, stopKind: StopKind): LoopState {
  const wt = integration(run);
  if (!run.ticket || !run.plan) {
    throw new Error("再開状態を残すチケットまたはプランがありません");
  }
  return {
    ticket: run.ticket,
    assumptions: run.assumptions,
    remaining: run.remaining,
    history: run.history,
    remainingTasks: run.remainingTasks,
    ingestPosition: run.ingestPosition,
    completedTaskIds: run.completedTaskIds,
    integrationBranch: wt.branch,
    integrationPath: wt.path,
    runId: run.runId,
    runDir: run.runDir,
    baseSha: run.baseSha,
    baseBranch: run.baseBranch,
    plan: run.plan,
    originalMaxLoops: run.originalMaxLoops,
    stopKind,
  };
}

function lastOutputFrom(run: Run): string {
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    const round = run.history[index]!;
    if (round.issues && round.issues.length > 0) {
      return formatIssues(round.issues);
    }
    if (round.checkOutput) {
      return round.checkOutput;
    }
  }
  return run.remaining.length > 0 ? formatIssues(run.remaining) : "";
}

function isPlanTask(run: Run, taskId: string): boolean {
  return run.plan?.tasks.some((task) => task.id === taskId) ?? false;
}

function phase(message: string): void {
  process.stderr.write(`[harness] ${message}\n`);
}
