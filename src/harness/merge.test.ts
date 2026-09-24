import assert from "node:assert/strict";
import test from "node:test";

import {
  commandFailureText,
  mergeBlockedByPolicy,
  mergePullRequestWhenReady,
  requiredChecksStillExpected,
  type GhCommand,
} from "./merge.ts";

const expectedStderr = [
  "GraphQL: Repository rule violations found",
  "",
  "2 of 2 required status checks are expected.",
  "",
  " (mergePullRequest)",
].join("\n");

test("必須チェックが未報告の拒否を待ち対象と判定する", () => {
  assert.equal(requiredChecksStillExpected(expectedStderr), true);
  assert.equal(requiredChecksStillExpected('Required status check "Unit tests" is expected.'), true);
  assert.equal(requiredChecksStillExpected("2 of 2 required status checks are pending."), true);
  assert.equal(requiredChecksStillExpected("1 of 2 required status checks are failing."), false);
  assert.equal(requiredChecksStillExpected("1 of 2 required status checks are expected, 1 failing."), false);
  assert.equal(mergeBlockedByPolicy("Pull request owner/repo#7 is not mergeable: the base branch policy prohibits the merge."), true);
});

test("必須チェックがなければすぐマージする", async () => {
  const calls: string[][] = [];
  await mergePullRequestWhenReady(async (args) => {
    calls.push(args);
    return "";
  }, { number: 7, onWaiting: () => assert.fail("待たない") });
  assert.deepEqual(calls, [["pr", "merge", "7", "--merge"]]);
});

test("必須チェックが報告されて成功するまで待ってからマージする", async () => {
  let merges = 0;
  let polls = 0;
  const waited: string[] = [];
  const gh: GhCommand = async (args) => {
    if (args[1] === "merge") {
      merges += 1;
      if (merges === 1) throw commandError(expectedStderr);
      if (merges === 2) throw commandError("2 of 2 required status checks are pending.");
      return "";
    }
    polls += 1;
    if (polls === 1) throw commandError("no checks reported on the 'integration' branch");
    if (polls === 2) {
      return JSON.stringify([
        { name: "Unit tests", bucket: "pending", state: "IN_PROGRESS" },
        { name: "E2E tests", bucket: "pending", state: "QUEUED" },
      ]);
    }
    return JSON.stringify([
      { name: "Unit tests", bucket: "pass", state: "SUCCESS" },
      { name: "E2E tests", bucket: "pass", state: "SUCCESS" },
    ]);
  };

  await mergePullRequestWhenReady(gh, {
    number: 7,
    sleep: async () => undefined,
    onWaiting: () => waited.push("wait"),
  });
  assert.equal(merges, 3);
  assert.deepEqual(waited, ["wait"]);
});

test("必須チェックが失敗したらマージしない", async () => {
  let merges = 0;
  const gh: GhCommand = async (args) => {
    if (args[1] === "merge") {
      merges += 1;
      throw commandError(expectedStderr);
    }
    return JSON.stringify([{ name: "Unit tests", bucket: "fail", state: "FAILURE" }]);
  };
  await assert.rejects(
    mergePullRequestWhenReady(gh, { number: 7, sleep: async () => undefined }),
    /Unit tests \(FAILURE\)/,
  );
  assert.equal(merges, 1);
});

test("チェックが現れないまま制限時間を超えたら終わる", async () => {
  let clock = 0;
  const gh: GhCommand = async (args) => {
    if (args[1] === "merge") throw commandError(expectedStderr);
    throw commandError("no required checks reported on the 'integration' branch");
  };
  await assert.rejects(
    mergePullRequestWhenReady(gh, {
      number: 7,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeoutMs: 25,
      intervalMs: 10,
    }),
    /待ち時間を超えました/,
  );
});

test("保護で拒否されても必須チェックが無ければ元のエラーを返す", async () => {
  let clock = 0;
  const policy = commandError("the base branch policy prohibits the merge");
  const gh: GhCommand = async (args) => {
    if (args[1] === "merge") throw policy;
    throw commandError("no checks reported on the 'integration' branch");
  };
  await assert.rejects(
    mergePullRequestWhenReady(gh, {
      number: 7,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeoutMs: 10_000,
      intervalMs: 10,
      policyGraceMs: 20,
    }),
    (error: unknown) => error === policy,
  );
});

test("無関係なマージ失敗はそのまま返す", async () => {
  const gh: GhCommand = async () => {
    throw commandError("GraphQL: something else (mergePullRequest)");
  };
  await assert.rejects(mergePullRequestWhenReady(gh, { number: 7 }), /something else/);
});

function commandError(stderr: string): Error {
  const error = new Error(`Command failed: gh\n${stderr}`) as Error & { stderr: string };
  error.stderr = stderr;
  assert.match(commandFailureText(error), new RegExp(stderr.split("\n")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return error;
}
