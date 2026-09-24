import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateCursorModels } from "./cursor-preflight.ts";
import type { WorkflowConfig } from "./config.ts";

const config = (smart: "grok" | "astra" = "grok"): WorkflowConfig => ({ models: { smart, cheap: "astra", cursorGrokId: "grok-4.6" }, phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false }, review: { maxLoops: 1 }, checks: [] });
const ok = async (_url: string | URL | Request, init?: RequestInit) => { assert.equal(new Headers(init?.headers).get("authorization"), "Bearer saved"); return new Response(JSON.stringify({ models: [{ id: "grok-4.6" }] })); };

test("validates selected model using saved credentials without environment key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-preflight-"));
  try {
    const authPath = path.join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({ cursor: { apiKey: "saved" } }));
    await validateCursorModels(config(), { authPath, apiKey: "", fetch: ok as typeof fetch });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reports missing key, absent model, and list retrieval failures", async () => {
  await assert.rejects(validateCursorModels(config(), { authPath: "/missing/auth.json", apiKey: "", fetch: ok as typeof fetch }), /認証キー/);
  await assert.rejects(validateCursorModels(config(), { apiKey: "key", fetch: async () => new Response(JSON.stringify({ models: [] })) as Response }), /選択 ID/);
  await assert.rejects(validateCursorModels(config(), { apiKey: "key", fetch: async () => { throw Error("network"); } }), /取得できません/);
});
