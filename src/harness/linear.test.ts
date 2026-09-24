import assert from "node:assert/strict";
import test from "node:test";
import { loadLinearIssue } from "./linear.ts";
import { loadLinearTicket } from "./ticket.ts";
import { runWorkflow } from "./workflow.ts";
import type { Steps } from "./contract.ts";
import type { WorkflowConfig } from "./config.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const response = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
const issue = { data: { issue: { identifier: "ABC-1", title: "Title", description: "  exact body\n" } } };

const minimalConfig: () => WorkflowConfig = () => ({ models: { smart: "test", cheap: "test" }, phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false }, review: { maxLoops: 1 }, checks: [] });
function workflowSteps(overrides: Partial<Steps>): Steps {
  const unavailable = async (): Promise<never> => { throw new Error("unexpected step"); };
  return { clarify: unavailable, plan: unavailable, implement: unavailable, review: unavailable, openPullRequest: unavailable, waitForChecks: unavailable, merge: unavailable, checkProduction: unavailable, ...overrides };
}

test("loads issue via fixed API endpoint, retaining body verbatim", async () => {
  let requestedUrl = "";
  let request: RequestInit | undefined;
  const result = await loadLinearIssue("https://linear.app/acme/issue/ABC-1/example", {
    apiKey: "secret",
    fetch: async (url, init) => {
      requestedUrl = String(url);
      request = init;
      return response(200, issue);
    },
  });
  assert.equal(requestedUrl, "https://api.linear.app/graphql");
  assert.equal((request?.headers as Record<string, string>).Authorization, "secret");
  assert.deepEqual(result, { ok: true, ticket: { path: "linear:ABC-1", title: "Title", body: "  exact body\n" } });
});

test("reports safe failure categories", async () => {
  const run = (status: number, payload: unknown) => loadLinearIssue("ABC-1", { apiKey: "token", fetch: async () => response(status, payload) });
  assert.deepEqual(await run(401, {}), { ok: false, reason: "authentication" });
  assert.deepEqual(await run(403, {}), { ok: false, reason: "permission" });
  assert.deepEqual(await run(500, {}), { ok: false, reason: "api" });
  assert.deepEqual(await run(200, { data: { issue: null } }), { ok: false, reason: "not_found" });
  assert.deepEqual(await run(200, { data: { issue: { title: "T", description: " \n" } } }), { ok: false, reason: "empty_body" });
  assert.deepEqual(await loadLinearIssue("ABC-1", { apiKey: "token", fetch: async () => { throw Error("secret"); } }), { ok: false, reason: "communication" });
  assert.deepEqual(await loadLinearIssue("ABC-1", { fetch: async () => response(200, issue) }), { ok: false, reason: "authentication" });
});

test("Linear ID and URL preserve ticket content and enter the normal clarification sequence", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "secret";
  globalThis.fetch = async () => response(200, issue);
  try {
  for (const input of ["ABC-1", "https://linear.app/acme/issue/ABC-1/example"]) {
    let calls = 0;
    const loaded = await loadLinearTicket(input);
    const repo = await mkdtemp(path.join(tmpdir(), "linear-workflow-"));
    const sequence: string[] = [];
    try {
      const result = await runWorkflow({ repo, ticket: loaded, config: minimalConfig(), steps: workflowSteps({
        clarify: async ({ ticket }) => { calls++; sequence.push("clarify"); assert.equal(ticket.title, "Title"); assert.equal(ticket.body, "  exact body\n"); return { decision: "return", questions: [] }; },
        plan: async () => { sequence.push("plan"); throw Error("unexpected"); },
      }) });
      assert.equal(result.status, "returned");
      assert.deepEqual(sequence, ["clarify"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
    assert.equal(calls, 1);
  }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
  }
});

test("Linear retrieval failure and empty body prevent workflow entry", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "secret";
  let started = false;
  try {
    for (const payload of [{ data: { issue: null } }, { data: { issue: { title: "Title", description: "  " } } }]) {
      globalThis.fetch = async () => response(200, payload);
      await assert.rejects(loadLinearTicket("ABC-1"));
      assert.equal(started, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
  }
});

test("rejects non-Linear URLs before making a request", async () => {
  let called = false;
  const result = await loadLinearIssue("https://attacker.example/issue/ABC-1", { apiKey: "secret", fetch: async () => { called = true; return response(200, issue); } });
  assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  assert.equal(called, false);
});
