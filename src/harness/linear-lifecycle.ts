import type { WorkflowResult } from "./workflow.ts";

export type LinearState = "In Progress" | "Done";
export type StateUpdater = (issueId: string, state: LinearState) => Promise<{ ok: true } | { ok: false; reason: string }>;

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
