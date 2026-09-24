import type { WorkflowResult } from "./workflow.ts";
import { updateLinearIssueState } from "./linear.ts";

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

export async function runLinearLifecycle<T extends WorkflowResult>(options: {
  issueId: string;
  updateLinearIssueState: StateUpdater;
  runWorkflow: () => Promise<T>;
}): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  const started = await options.updateLinearIssueState(options.issueId, "In Progress");
  if (!started.ok) return started;
  const result = await options.runWorkflow();
  if (result.status !== "ready" && result.status !== "production-ok") return { ok: true, result };
  const completed = await options.updateLinearIssueState(options.issueId, "Done");
  return completed.ok ? { ok: true, result } : completed;
}
