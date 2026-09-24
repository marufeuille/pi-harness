import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadConfig, parseConfig } from "./config.ts";
import { modelCatalog } from "./models.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));

test("既定の設定は astra で考え、grok で実装し、PR 以降は止める", async () => {
  const config = await loadConfig(path.join(harnessRoot, "config", "harness.json"));
  assert.deepEqual(config.models, { smart: "astra", cheap: "grok", cursorGrokId: "grok-4.6" });
  assert.equal(config.phases.pullRequest, false);
  assert.equal(config.phases.merge, false);
  assert.equal(modelCatalog.grok.id, "grok-4.6");
  assert.equal(modelCatalog.fable.id, "claude-fable-5-1");
});

test("モデルの組み合わせは別名で差し替えられる", () => {
  const config = parseConfig({
    models: { smart: "grok", cheap: "luna" },
    phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false },
    review: { maxLoops: 2 },
    checks: ["npm test"],
  });
  assert.deepEqual(config.models, { smart: "grok", cheap: "luna" });
  assert.deepEqual(config.checks, ["npm test"]);
});

test("Cursor Grok ID は任意の非空文字列を受け入れる", () => {
  const base = {
    models: { smart: "astra", cheap: "grok" },
    phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false },
    review: { maxLoops: 1 },
  };
  assert.equal(parseConfig(base).models.cursorGrokId, undefined);
  assert.equal(parseConfig({ ...base, models: { ...base.models, cursorGrokId: "grok-4.7" } }).models.cursorGrokId, "grok-4.7");
  assert.equal(parseConfig({ ...base, models: { ...base.models, cursorGrokId: "custom/model id" } }).models.cursorGrokId, "custom/model id");
  assert.throws(() => parseConfig({ ...base, models: { ...base.models, cursorGrokId: "  " } }), /models\.cursorGrokId/);
});

test("知らないモデル名と、順序が崩れた段階は受け取らない", () => {
  assert.throws(
    () =>
      parseConfig({
        models: { smart: "astra", cheap: "unknown" },
        phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false },
        review: { maxLoops: 1 },
      }),
    /models\.cheap/,
  );
  assert.throws(
    () =>
      parseConfig({
        models: { smart: "astra", cheap: "grok" },
        phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: true },
        review: { maxLoops: 1 },
        productionCheckCommand: "true",
      }),
    /phases\.merge/,
  );
});
