import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadConfig, parseConfig } from "./config.ts";
import { modelCatalog } from "./models.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));
const base = { phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false }, review: { maxLoops: 2 }, checks: ["npm test"] };

test("明示されたモデル指定と既定別名は parameters 形式になる", async () => {
  const config = await loadConfig(path.join(harnessRoot, "config", "harness.json"));
  assert.deepEqual(config.models.smart, modelCatalog.astra);
  assert.deepEqual(config.models.cheap, modelCatalog.grok);
  for (const alias of ["astra", "luna", "grok", "fable"] as const) {
    const explicit = parseConfig({ ...base, models: { smart: modelCatalog[alias], cheap: modelCatalog[alias] } });
    assert.deepEqual(explicit.models.smart, modelCatalog[alias]);
  }
  const grok = parseConfig({ ...base, models: { smart: { provider: "xai", id: "grok-4.7", parameters: { effort: "xhigh", fast: false, contextWindow: 100000 } }, cheap: modelCatalog.luna } });
  assert.deepEqual(grok.models.smart.parameters, { effort: "xhigh", fast: false, contextWindow: 100000 });
});

test("parameters 自体と値を検証する", () => {
  for (const parameters of [null, [], "bad", { effort: 2 }, { fast: "yes" }, { contextWindow: 0 }]) {
    assert.throws(() => parseConfig({ ...base, models: { smart: { provider: "x", id: "m", parameters }, cheap: modelCatalog.luna } }), /parameters/);
  }
});

test("Cursor Grok ID は任意の非空文字列を受け入れる", () => {
  const config = (cursorGrokId?: string) => parseConfig({ ...base, models: { smart: modelCatalog.astra, cheap: modelCatalog.grok, ...(cursorGrokId === undefined ? {} : { cursorGrokId }) } });
  assert.equal(config().models.cursorGrokId, undefined);
  assert.equal(config("grok-4.7").models.cursorGrokId, "grok-4.7");
  assert.throws(() => config("  "), /models\.cursorGrokId/);
});
