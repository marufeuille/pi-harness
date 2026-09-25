import type { Worktree } from "./worktrees.ts";

export type Ticket = {
  path: string;
  title: string;
  body: string;
};

export type Task = {
  id: string;
  title: string;
  dependsOn: string[];
  instructions: string;
};

export type Plan = {
  assumptions: string[];
  tasks: Task[];
} | JsonReadFailure;

export type JsonReadFailure = { decision: "json-read-failed"; stage: "clarify" | "plan" | "review"; attempt: number; text: string };

export type Clarification =
  | { decision: "proceed"; assumptions: string[] }
  | { decision: "return"; questions: string[] }
  | JsonReadFailure;

export type Review =
  | { decision: "pass"; concerns: string[] }
  | { decision: "fix"; issues: Task[] }
  | { decision: "return"; questions: string[] }
  | { decision: "escalate"; reason: string }
  | JsonReadFailure;

export type PullRequest = {
  url: string;
  number: number;
};

export type ProductionCheck =
  | { decision: "ok"; summary: string }
  | { decision: "problem"; summary: string };

export type ClarifyInput = {
  ticket: Ticket;
  cwd: string;
};

export type PlanInput = {
  ticket: Ticket;
  assumptions: string[];
  cwd: string;
  remaining?: Task[];
};

export type ImplementInput = {
  task: Task;
  worktree: Worktree;
  ticket: Ticket;
};

export type ReviewInput = {
  ticket: Ticket;
  plan: Plan;
  attempt: number;
  maxLoops: number;
  cwd: string;
  baseSha: string;
};

export type PullRequestInput = {
  cwd: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  assumptions: string[];
  concerns: string[];
};

export type PullRequestActionInput = {
  cwd: string;
  pullRequest: PullRequest;
};

export type ProductionInput = PullRequestActionInput & {
  command: string;
};

export type Steps = {
  clarify(input: ClarifyInput): Promise<Clarification>;
  plan(input: PlanInput): Promise<Plan>;
  implement(input: ImplementInput): Promise<void>;
  review(input: ReviewInput): Promise<Review>;
  openPullRequest(input: PullRequestInput): Promise<PullRequest>;
  waitForChecks(input: PullRequestActionInput): Promise<void>;
  merge(input: PullRequestActionInput): Promise<void>;
  checkProduction(input: ProductionInput): Promise<ProductionCheck>;
};

export function parseJsonBlock(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("モデル出力から JSON を読めませんでした");
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}

export function parseClarification(value: unknown): Clarification {
  const record = asRecord(value, "要件確認");
  if (record.decision === "proceed" && isStringArray(record.assumptions)) {
    return { decision: "proceed", assumptions: record.assumptions };
  }
  if (record.decision === "return" && isStringArray(record.questions) && record.questions.length > 0) {
    return { decision: "return", questions: record.questions };
  }
  throw new Error("要件確認の JSON が契約と違います");
}

export function parsePlan(value: unknown): Plan {
  const record = asRecord(value, "プラン");
  if (!isStringArray(record.assumptions) || !Array.isArray(record.tasks) || record.tasks.length === 0) {
    throw new Error("プランの JSON が契約と違います");
  }
  return {
    assumptions: record.assumptions,
    tasks: record.tasks.map((task) => parseTask(task)),
  };
}

export function parseReview(value: unknown): Review {
  const record = asRecord(value, "検品");
  if (record.decision === "pass" && isStringArray(record.concerns)) {
    return { decision: "pass", concerns: record.concerns };
  }
  if (record.decision === "fix" && Array.isArray(record.issues) && record.issues.length > 0) {
    return { decision: "fix", issues: record.issues.map((issue) => parseTask(issue)) };
  }
  if (record.decision === "return" && isStringArray(record.questions) && record.questions.length > 0) {
    return { decision: "return", questions: record.questions };
  }
  if (record.decision === "escalate" && typeof record.reason === "string" && record.reason.length > 0) {
    return { decision: "escalate", reason: record.reason };
  }
  throw new Error("検品の JSON が契約と違います");
}

function parseTask(value: unknown): Task {
  const record = asRecord(value, "タスク");
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.instructions !== "string" ||
    !isStringArray(record.dependsOn)
  ) {
    throw new Error("タスクの JSON が契約と違います");
  }
  return {
    id: record.id,
    title: record.title,
    dependsOn: record.dependsOn,
    instructions: record.instructions,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}の JSON がオブジェクトではありません`);
  }
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
