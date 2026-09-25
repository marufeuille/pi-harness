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
  mentionedResumeActions,
  recommendationFor,
  recommendedResumeAction,
  type StopKind,
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
  const kinds: StopKind[] = [
    "decreasing-fatal",
    "stalled",
    "changing",
    "insufficient-requirements",
    "conflict",
    "branch-deviation",
    "environment-check",
  ];
  for (const kind of kinds) {
    const recommendation = recommendationFor(kind);
    const mentioned = mentionedResumeActions(recommendation);
    assert.equal(mentioned.length, 1);
    assert.equal(mentioned[0], recommendedResumeAction(kind));
    assert.ok(allowedResumeActions(kind).includes(mentioned[0]!));
  }
  assert.deepEqual(allowedResumeActions("decreasing-fatal"), ["extraRounds"]);
  assert.deepEqual(allowedResumeActions("stalled"), ["hint", "replanRemaining"]);
  assert.deepEqual(mentionedResumeActions(recommendationFor("stalled")), ["hint"]);
  assert.equal(recommendationFor("stalled").includes("追加回数"), false);
  assert.deepEqual(allowedResumeActions("changing"), ["extraRounds", "hint", "replanRemaining"]);
  assert.equal(mentionedResumeActions(recommendationFor("changing")).length, 1);
  assert.ok(allowedResumeActions("changing").includes(mentionedResumeActions(recommendationFor("changing"))[0]!));
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
  assert.equal(mentionedResumeActions(conflict.recommendation).length, 1);
  assert.equal(makeStopSnapshot({
    kind: "stalled",
    lastOutput: "同じ",
    trend: "same",
    branch: "b",
    worktree: "w",
    conflicts: ["ignored"],
  }).conflicts, undefined);
});
