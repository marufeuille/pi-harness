import assert from "node:assert/strict";
import test from "node:test";

import { parseClarification, parseJsonBlock, parsePlan, parseReview } from "./contract.ts";

test("モデル出力の JSON を読む", () => {
  const fenced = parseJsonBlock('説明\n```json\n{"decision":"proceed","assumptions":["名前は必須"]}\n```\n');
  assert.deepEqual(parseClarification(fenced), {
    decision: "proceed",
    assumptions: ["名前は必須"],
  });

  const raw = parseJsonBlock('{"assumptions":[],"tasks":[{"id":"add-greet","title":"挨拶","dependsOn":[],"instructions":"境界を満たす"}]}');
  assert.equal(parsePlan(raw).tasks[0]?.id, "add-greet");
});

test("曖昧なチケットは質問付きで突き返す", () => {
  assert.deepEqual(parseClarification({ decision: "return", questions: ["失敗時の戻り値は何か"] }), {
    decision: "return",
    questions: ["失敗時の戻り値は何か"],
  });
});

test("検品は pass / fix / escalate だけを受け付ける", () => {
  assert.equal(parseReview({ decision: "pass", concerns: ["ログの文言"] }).decision, "pass");
  assert.equal(
    parseReview({
      decision: "fix",
      issues: [{ id: "fix-boundary", title: "境界", dependsOn: [], instructions: "空白を拒否する" }],
    }).decision,
    "fix",
  );
  assert.throws(() => parseReview({ decision: "pass", concerns: "文字列" }), /契約/);
});
