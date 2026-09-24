import assert from "node:assert/strict";
import test from "node:test";
import { loadLinearIssue } from "./linear.ts";

const response = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
const issue = { data: { issue: { identifier: "ABC-1", title: "Title", description: "  exact body\n" } } };

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

test("rejects non-Linear URLs before making a request", async () => {
  let called = false;
  const result = await loadLinearIssue("https://attacker.example/issue/ABC-1", { apiKey: "secret", fetch: async () => { called = true; return response(200, issue); } });
  assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  assert.equal(called, false);
});
