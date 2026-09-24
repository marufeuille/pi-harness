import assert from "node:assert/strict";
import { test } from "node:test";
import { runLinearLifecycle, updateLinearStateResult } from "./linear-lifecycle.ts";
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

test("state result adapter calls the Linear API and maps success and failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LINEAR_API_KEY;
  const requests: Array<{ query: string; variables: Record<string, string> }> = [];
  process.env.LINEAR_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
    requests.push(request);
    return new Response(JSON.stringify(request.query.startsWith("query")
      ? { data: { issue: { id: "internal-id", team: { states: { nodes: [{ id: "state-id", name: request.variables.id === "ABC-1" ? "In Progress" : "Done" }] } } } } }
      : { data: { issueUpdate: { success: true } } }), { status: 200 });
  };
  try {
    assert.deepEqual(await updateLinearStateResult("ABC-1", "In Progress"), { ok: true });
    assert.match(requests[1]!.query, /issueUpdate/);
    globalThis.fetch = async () => new Response("{}", { status: 403 });
    assert.deepEqual(await updateLinearStateResult("ABC-1", "Done"), { ok: false, reason: "permission" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
  }
});

test("workflow exceptions do not trigger completion or rollback", async () => {
  const calls: string[] = [];
  await assert.rejects(runLinearLifecycle({ issueId: "X", updateLinearIssueState: async (_id, state) => { calls.push(state); return { ok: true }; }, runWorkflow: async () => { throw new Error("failed"); } }), /failed/);
  assert.deepEqual(calls, ["In Progress"]);
});
