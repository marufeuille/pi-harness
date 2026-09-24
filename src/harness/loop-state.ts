import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Task, Ticket } from "./contract.ts";
import { allowedResumeActions, type LoopRound, type StopKind } from "./loop-stop.ts";

export type TaskPlan = {
  assumptions: string[];
  tasks: Task[];
};

export type LoopState = {
  ticket: Ticket;
  assumptions: string[];
  remaining: Task[];
  history: LoopRound[];
  remainingTasks: Task[];
  ingestPosition: number;
  completedTaskIds: string[];
  integrationBranch: string;
  integrationPath: string;
  runId: string;
  runDir: string;
  baseSha: string;
  baseBranch: string;
  plan: TaskPlan;
  originalMaxLoops: number;
  stopKind: StopKind;
  linearIssueId?: string;
};

export type ResumeAction =
  | { extraRounds: number }
  | { hint: string }
  | { replanRemaining: true }
  | { answers: string[] }
  | { continueFromIngest: true };

export type ResumeInput = {
  state: LoopState;
  extraRounds?: number;
  hint?: string;
  replanRemaining?: boolean;
  answers?: string[];
  continueFromIngest?: boolean;
};

export function readyTasks(tasks: Task[], completedIds: ReadonlySet<string>): Task[] {
  return tasks
    .filter((task) => !completedIds.has(task.id))
    .map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependency) => !completedIds.has(dependency)),
    }));
}

export function withHint(tasks: Task[], hint: string): Task[] {
  return tasks.map((task) => ({
    ...task,
    instructions: `${task.instructions}\n\n人のヒント: ${hint}`,
  }));
}

export function applyHint(state: LoopState, hint: string): LoopState {
  if (state.remaining.length > 0) {
    return { ...state, remaining: withHint(state.remaining, hint) };
  }
  return { ...state, remainingTasks: withHint(state.remainingTasks, hint) };
}

export function applyAnswers(state: LoopState, answers: string[]): LoopState {
  return {
    ...state,
    assumptions: [...state.assumptions, ...answers],
  };
}

export function resumeActionFrom(input: ResumeInput): ResumeAction {
  const actions: ResumeAction[] = [];
  if (input.extraRounds !== undefined) {
    if (!Number.isInteger(input.extraRounds) || input.extraRounds < 1) {
      throw new Error("追加回数は 1 以上の整数にしてください");
    }
    actions.push({ extraRounds: input.extraRounds });
  }
  if (input.hint !== undefined) {
    if (typeof input.hint !== "string" || input.hint.trim().length === 0) {
      throw new Error("人のヒントが空です");
    }
    actions.push({ hint: input.hint });
  }
  if (input.replanRemaining === true) {
    actions.push({ replanRemaining: true });
  }
  if (input.answers !== undefined) {
    if (!Array.isArray(input.answers) || input.answers.length === 0 || input.answers.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error("質問への回答は空でない文字列の配列にしてください");
    }
    actions.push({ answers: input.answers });
  }
  if (input.continueFromIngest === true) {
    actions.push({ continueFromIngest: true });
  }
  if (actions.length !== 1) {
    throw new Error("再開の入力は次の一手だけにしてください");
  }
  return actions[0]!;
}

export function assertResumeAllowed(kind: StopKind, action: ResumeAction): void {
  const allowed = allowedResumeActions(kind);
  const name = actionName(action);
  if (!allowed.includes(name)) {
    throw new Error(`この停止種類では ${labelFor(name)} による再開はできません`);
  }
}

export function actionName(action: ResumeAction): "extraRounds" | "hint" | "replanRemaining" | "answers" | "continueFromIngest" {
  if ("extraRounds" in action) return "extraRounds";
  if ("hint" in action) return "hint";
  if ("replanRemaining" in action) return "replanRemaining";
  if ("answers" in action) return "answers";
  return "continueFromIngest";
}

export async function saveLoopState(runDir: string, state: LoopState): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "loop-state.json"), JSON.stringify(state, null, 2));
}

export function loopStateFile(runDirOrFile: string): string {
  return runDirOrFile.endsWith("loop-state.json") ? runDirOrFile : path.join(runDirOrFile, "loop-state.json");
}

export async function loadLoopState(runDirOrFile: string): Promise<LoopState> {
  const file = loopStateFile(runDirOrFile);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`再開状態を読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isLoopState(raw)) {
    throw new Error("再開状態の形式が不正です");
  }
  return raw;
}

function isLoopState(value: unknown): value is LoopState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === "string" &&
    typeof record.runDir === "string" &&
    typeof record.integrationBranch === "string" &&
    typeof record.integrationPath === "string" &&
    typeof record.stopKind === "string" &&
    typeof record.originalMaxLoops === "number" &&
    Array.isArray(record.completedTaskIds) &&
    Array.isArray(record.remainingTasks) &&
    typeof record.ingestPosition === "number" &&
    record.ticket !== undefined &&
    record.plan !== undefined &&
    (record.linearIssueId === undefined || (typeof record.linearIssueId === "string" && record.linearIssueId.length > 0))
  );
}

function labelFor(name: ReturnType<typeof actionName>): string {
  switch (name) {
    case "extraRounds":
      return "追加回数";
    case "hint":
      return "人のヒント";
    case "replanRemaining":
      return "残件の再プラン";
    case "answers":
      return "質問への回答";
    case "continueFromIngest":
      return "取り込み以降の続き";
  }
}
