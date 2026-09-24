import type { Task } from "./contract.ts";

export type StopKind =
  | "decreasing-fatal"
  | "stalled"
  | "changing"
  | "insufficient-requirements"
  | "conflict"
  | "branch-deviation"
  | "environment-check";

export type LoopTrend = "decreasing" | "same" | "shifted";

export type LoopRound = {
  attempt: number;
  issues?: Task[];
  checkOutput?: string;
};

export type StopSnapshot = {
  kind: StopKind;
  lastOutput: string;
  trend: LoopTrend;
  branch: string;
  worktree: string;
  recommendation: string;
};

export type ResumeActionName = "extraRounds" | "hint" | "replanRemaining" | "answers" | "continueFromIngest";

export function issueFingerprint(issues: Task[]): string {
  return issues
    .map((issue) => `${issue.id}\n${issue.title}\n${issue.instructions}`)
    .sort()
    .join("\n---\n");
}

export function formatIssues(issues: Task[]): string {
  return issues.map((issue) => `${issue.id}: ${issue.title}\n${issue.instructions}`).join("\n\n");
}

export function normalizeCheckOutput(output: string): string {
  return output.trim().replace(/\s+/g, " ");
}

export function classifyIssueTrend(history: readonly LoopRound[]): LoopTrend {
  const rounds = history.filter((round) => round.issues && round.issues.length > 0);
  if (rounds.length < 2) {
    return "decreasing";
  }
  const previous = rounds[rounds.length - 2]!.issues!;
  const current = rounds[rounds.length - 1]!.issues!;
  if (issueFingerprint(previous) === issueFingerprint(current)) {
    return "same";
  }
  if (current.length < previous.length) {
    return "decreasing";
  }
  return "shifted";
}

export function classifyCheckTrend(history: readonly LoopRound[]): LoopTrend {
  const rounds = history.filter((round) => round.checkOutput !== undefined);
  if (rounds.length < 2) {
    return "shifted";
  }
  const previous = normalizeCheckOutput(rounds[rounds.length - 2]!.checkOutput!);
  const current = normalizeCheckOutput(rounds[rounds.length - 1]!.checkOutput!);
  return previous === current ? "same" : "shifted";
}

export function isEnvironmentCheckFailure(output: string): boolean {
  return (
    /command not found/i.test(output) ||
    /not found in (\$)?PATH/i.test(output) ||
    /permission denied/i.test(output) ||
    /\bEACCES\b/.test(output) ||
    /\bEPERM\b/.test(output) ||
    /authentication (failed|required|error)/i.test(output) ||
    /unauthorized/i.test(output) ||
    /認証に失敗/.test(output) ||
    /権限がありません/.test(output) ||
    /コマンドがありません/.test(output)
  );
}

export function recommendationFor(kind: StopKind): string {
  switch (kind) {
    case "decreasing-fatal":
      return "追加回数を指定して、同じ統合ブランチの残件を続ける";
    case "stalled":
      return "人のヒントを残件に足すか、残件だけプランを作り直す";
    case "changing":
      return "追加回数、人のヒント、残件の再プランのいずれかを選ぶ";
    case "insufficient-requirements":
      return "質問に回答する";
    case "conflict":
      return "衝突を解消した同じブランチから取り込み以降を続ける";
    case "branch-deviation":
      return "作業ツリーのブランチを戻した同じブランチから取り込み以降を続ける";
    case "environment-check":
      return "環境の問題を解消した同じブランチから取り込み以降を続ける";
  }
}

export function allowedResumeActions(kind: StopKind): ResumeActionName[] {
  switch (kind) {
    case "decreasing-fatal":
      return ["extraRounds"];
    case "stalled":
      return ["hint", "replanRemaining"];
    case "changing":
      return ["extraRounds", "hint", "replanRemaining"];
    case "insufficient-requirements":
      return ["answers"];
    case "conflict":
    case "branch-deviation":
    case "environment-check":
      return ["continueFromIngest"];
  }
}

export function kindForIssueLimit(trend: LoopTrend): StopKind {
  if (trend === "same") {
    return "stalled";
  }
  if (trend === "shifted") {
    return "changing";
  }
  return "decreasing-fatal";
}

export function makeStopSnapshot(input: {
  kind: StopKind;
  lastOutput: string;
  trend: LoopTrend;
  branch: string;
  worktree: string;
}): StopSnapshot {
  return {
    ...input,
    recommendation: recommendationFor(input.kind),
  };
}

export function checkFixTask(attempt: number, output: string): Task {
  return {
    id: `checks-${attempt}`,
    title: "失敗したチェックを直す",
    dependsOn: [],
    instructions: output,
  };
}
