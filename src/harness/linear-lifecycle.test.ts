import assert from "node:assert/strict";
import { test } from "node:test";
import { runLinearLifecycle } from "./linear-lifecycle.ts";
import type { WorkflowResult } from "./workflow.ts";

const result = (status: WorkflowResult["status"]) => ({ status } as WorkflowResult);

test("Linear lifecycle orders start, workflow, and completion only for success", async () => {
  for (const status of ["ready", "production-ok", "returned", "escalated", "production-failed"] as const) {
    const calls: string[] = [];
    const value = result(status);
    const outcome = await runLinearLifecycle({
      issueId: "ABC-1",
      updateLinearIssueState: async (_id, state) => { calls.push(state); return { ok: true }; },
      runWorkflow: async () => { calls.push("workflow"); return value; },
    });
    assert.deepEqual(calls, status === "ready" || status === "production-ok" ? ["In Progress", "workflow", "Done"] : ["In Progress", "workflow"]);
    assert.deepEqual(outcome, { ok: true, result: value });
  }
});

test("failed start prevents workflow and failed completion withholds success", async () => {
  let runs = 0;
  const startFailure = await runLinearLifecycle({ issueId: "X", updateLinearIssueState: async () => ({ ok: false, reason: "start failed" }), runWorkflow: async () => { runs++; return result("ready"); } });
  assert.deepEqual(startFailure, { ok: false, reason: "start failed" });
  assert.equal(runs, 0);
  const completionFailure = await runLinearLifecycle({ issueId: "X", updateLinearIssueState: async (_id, state) => state === "Done" ? ({ ok: false, reason: "done failed" }) : ({ ok: true }), runWorkflow: async () => result("ready") });
  assert.deepEqual(completionFailure, { ok: false, reason: "done failed" });
});

test("workflow exceptions do not trigger completion or rollback", async () => {
  const calls: string[] = [];
  await assert.rejects(runLinearLifecycle({ issueId: "X", updateLinearIssueState: async (_id, state) => { calls.push(state); return { ok: true }; }, runWorkflow: async () => { throw new Error("failed"); } }), /failed/);
  assert.deepEqual(calls, ["In Progress"]);
});
