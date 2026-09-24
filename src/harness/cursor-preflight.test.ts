import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateCursorModels } from "./cursor-preflight.ts";
import type { WorkflowConfig } from "./config.ts";

const config = (): WorkflowConfig => ({ models: { smart: { provider: "cursor", id: "grok-4.6", parameters: { effort: "medium" } }, cheap: { provider: "openai-codex", id: "gpt-6-astra", parameters: { effort: "high" } }, cursorGrokId: "grok-4.6" }, phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false }, review: { maxLoops: 1 }, checks: [] });
const ok = async (key: string) => { assert.equal(key, "saved"); return [{ id: "grok-4.6" }]; };

test("validates selected model using saved credentials without environment key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-preflight-"));
  try {
    const authPath = path.join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({ cursor: { type: "api_key", key: "saved" } }));
    await validateCursorModels(config(), { authPath, apiKey: "", listModels: ok });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reports missing key, absent model, and list retrieval failures", async () => {
  await assert.rejects(validateCursorModels(config(), { authPath: "/missing/auth.json", apiKey: "", listModels: ok }), /認証キー/);
  await assert.rejects(validateCursorModels(config(), { apiKey: "key", listModels: async () => [] }), /選択 ID/);
  await assert.rejects(validateCursorModels(config(), { apiKey: "key", listModels: async () => { throw Error("network"); } }), /取得できません/);
});
