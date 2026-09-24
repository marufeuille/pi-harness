import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "./contract.ts";
import {
  allowedResumeActions,
  checkFixTask,
  classifyCheckTrend,
  classifyIssueTrend,
  formatIssues,
  isEnvironmentCheckFailure,
  kindForIssueLimit,
  makeStopSnapshot,
  recommendationFor,
} from "./loop-stop.ts";

const issue = (id: string, text = id): Task => ({ id, title: id, dependsOn: [], instructions: text });

test("指摘の傾向は減少・同一・別内容を区別する", () => {
  const first = [issue("a"), issue("b"), issue("c")];
  const fewer = [issue("a"), issue("b")];
  const same = [issue("b"), issue("a")];
  const shifted = [issue("x"), issue("y")];
  assert.equal(classifyIssueTrend([{ attempt: 1, issues: first }]), "decreasing");
  assert.equal(classifyIssueTrend([{ attempt: 1, issues: first }, { attempt: 2, issues: fewer }]), "decreasing");
  assert.equal(classifyIssueTrend([{ attempt: 1, issues: same }, { attempt: 2, issues: same }]), "same");
  assert.equal(classifyIssueTrend([{ attempt: 1, issues: fewer }, { attempt: 2, issues: shifted }]), "shifted");
});

test("チェック出力の傾向は同一とすり替わりを区別する", () => {
  assert.equal(classifyCheckTrend([{ attempt: 1, checkOutput: "fail-1" }]), "shifted");
  assert.equal(
    classifyCheckTrend([
      { attempt: 1, checkOutput: "fail-a" },
      { attempt: 2, checkOutput: "fail-a" },
    ]),
    "same",
  );
  assert.equal(
    classifyCheckTrend([
      { attempt: 1, checkOutput: "fail-a" },
      { attempt: 2, checkOutput: "fail-b" },
    ]),
    "shifted",
  );
});

test("作業ツリーでは直せないチェック失敗を検出する", () => {
  assert.equal(isEnvironmentCheckFailure("sh: foo: command not found"), true);
  assert.equal(isEnvironmentCheckFailure("permission denied: .env"), true);
  assert.equal(isEnvironmentCheckFailure("EACCES: open"), true);
  assert.equal(isEnvironmentCheckFailure("authentication failed"), true);
  assert.equal(isEnvironmentCheckFailure("unauthorized token"), true);
  assert.equal(isEnvironmentCheckFailure("expected 2 to equal 1"), false);
});

test("停止種類ごとの推奨と再開手段が仕様どおり", () => {
  assert.match(recommendationFor("decreasing-fatal"), /追加回数/);
  assert.deepEqual(allowedResumeActions("decreasing-fatal"), ["extraRounds"]);
  assert.match(recommendationFor("stalled"), /ヒント/);
  assert.match(recommendationFor("stalled"), /プラン/);
  assert.equal(recommendationFor("stalled").includes("追加回数"), false);
  assert.deepEqual(allowedResumeActions("stalled"), ["hint", "replanRemaining"]);
  assert.match(recommendationFor("changing"), /追加回数/);
  assert.match(recommendationFor("changing"), /ヒント/);
  assert.match(recommendationFor("changing"), /再プラン/);
  assert.deepEqual(allowedResumeActions("changing"), ["extraRounds", "hint", "replanRemaining"]);
  assert.deepEqual(allowedResumeActions("insufficient-requirements"), ["answers"]);
  assert.deepEqual(allowedResumeActions("conflict"), ["continueFromIngest"]);
  assert.deepEqual(allowedResumeActions("branch-deviation"), ["continueFromIngest"]);
  assert.deepEqual(allowedResumeActions("environment-check"), ["continueFromIngest"]);
  assert.equal(kindForIssueLimit("decreasing"), "decreasing-fatal");
  assert.equal(kindForIssueLimit("same"), "stalled");
  assert.equal(kindForIssueLimit("shifted"), "changing");
  assert.match(formatIssues([issue("fix-a", "空白を拒否する")]), /fix-a/);
  assert.equal(checkFixTask(2, "boom").id, "checks-2");
  const conflict = makeStopSnapshot({
    kind: "conflict",
    lastOutput: "衝突",
    trend: "same",
    branch: "harness/run/integration",
    worktree: "/tmp/integration",
    conflicts: ["shared.txt"],
  });
  assert.deepEqual(conflict.conflicts, ["shared.txt"]);
  assert.equal(typeof conflict.recommendation, "string");
  assert.equal(conflict.recommendation.includes("\n"), false);
  assert.equal(makeStopSnapshot({
    kind: "stalled",
    lastOutput: "同じ",
    trend: "same",
    branch: "b",
    worktree: "w",
    conflicts: ["ignored"],
  }).conflicts, undefined);
});
