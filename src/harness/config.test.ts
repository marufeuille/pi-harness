import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadConfig, parseConfig } from "./config.ts";
import { modelCatalog, resolveAndValidateModel, registerModelDefinition, registerRuntimeModel } from "./models.ts";

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

test("モデル固有の既定値を適用し、fast false とカタログ追加モデルを保持する", () => {
  const defaulted = resolveAndValidateModel({ provider: "xai", id: "grok-4.7" }, "smart");
  assert.deepEqual(defaulted.parameters, { effort: "medium", fast: true });
  const disabled = resolveAndValidateModel({ provider: "xai", id: "grok-4.7", parameters: { effort: "xhigh", fast: false } }, "smart");
  assert.deepEqual(disabled.parameters, { effort: "xhigh", fast: false });
  registerModelDefinition({ provider: "xai", id: "grok-next", parameters: { effort: { values: ["high"], default: "high" } } });
  assert.deepEqual(resolveAndValidateModel({ provider: "xai", id: "grok-next" }, "smart").parameters, { effort: "high" });
  assert.throws(() => resolveAndValidateModel({ provider: "xai", id: "grok-4.7", parameters: { effort: "turbo" } }, "smart"), /非対応 effort/);
});

test("実行時カタログが supportsFast を出すモデルは fast false を受け入れる", () => {
  registerRuntimeModel({
    provider: "cursor",
    id: "grok-runtime-fast",
    thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    contextWindow: 200000,
    supportsFast: true,
    defaultFast: true,
  });
  const disabled = resolveAndValidateModel(
    { provider: "cursor", id: "grok-runtime-fast", parameters: { effort: "xhigh", fast: false } },
    "models.cheap",
  );
  assert.equal(disabled.parameters?.fast, false);
  assert.equal(disabled.parameters?.effort, "xhigh");
  registerRuntimeModel({
    provider: "cursor",
    id: "grok-runtime-no-fast",
    thinkingLevelMap: { medium: "medium" },
    contextWindow: 200000,
  });
  assert.throws(
    () => resolveAndValidateModel(
      { provider: "cursor", id: "grok-runtime-no-fast", parameters: { effort: "medium", fast: false } },
      "models.cheap",
    ),
    /非対応パラメータ fast/,
  );
});

test("Cursor Grok ID は任意の非空文字列を受け入れる", () => {
  const config = (cursorGrokId?: string) => parseConfig({ ...base, models: { smart: modelCatalog.astra, cheap: modelCatalog.grok, ...(cursorGrokId === undefined ? {} : { cursorGrokId }) } });
  assert.equal(config().models.cursorGrokId, undefined);
  assert.equal(config("grok-4.7").models.cursorGrokId, "grok-4.7");
  assert.throws(() => config("  "), /models\.cursorGrokId/);
});
