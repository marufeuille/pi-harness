import type { WorkflowResult } from "./workflow.ts";
import { parseLinearIssueId, updateLinearIssueState } from "./linear.ts";

export type LinearState = "In Progress" | "Done";
export type StateUpdater = (issueId: string, state: LinearState) => Promise<{ ok: true } | { ok: false; reason: string }>;

export async function updateLinearStateResult(issueId: string, state: LinearState): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await updateLinearIssueState(issueId, state);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.match(/Linear state update failed: (.+)$/)?.[1] ?? message };
  }
}

export function resolveResumeLinearIssueId(options: {
  requested?: string;
  saved?: string;
}): { ok: true; issueId?: string } | { ok: false; reason: string } {
  let requestedId: string | undefined;
  if (options.requested !== undefined) {
    requestedId = parseLinearIssueId(options.requested);
    if (!requestedId) return { ok: false, reason: "課題 ID または URL が不正です" };
  }
  const saved = options.saved?.trim() || undefined;
  if (requestedId && requestedId !== saved) {
    return { ok: false, reason: "再開では元の Linear 課題と異なる課題を指定できません" };
  }
  return { ok: true, issueId: saved };
}

export async function runLinearLifecycle<T extends WorkflowResult>(options: {
  issueId: string;
  updateLinearIssueState: StateUpdater;
  runWorkflow: () => Promise<T>;
  resume?: boolean;
}): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  if (!options.resume) {
    const started = await options.updateLinearIssueState(options.issueId, "In Progress");
    if (!started.ok) return started;
  }
  const result = await options.runWorkflow();
  if (result.status !== "ready" && result.status !== "production-ok") return { ok: true, result };
  const completed = await options.updateLinearIssueState(options.issueId, "Done");
  return completed.ok ? { ok: true, result } : completed;
}
