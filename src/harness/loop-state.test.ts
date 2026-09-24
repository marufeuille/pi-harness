import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Task, Ticket } from "./contract.ts";
import {
  applyAnswers,
  applyHint,
  assertResumeAllowed,
  dedicatedBaseBranch,
  loadLoopState,
  readyTasks,
  resumeActionFrom,
  saveLoopState,
  shouldPublishBaseFrom,
  type LoopState,
} from "./loop-state.ts";
import type { StopKind } from "./loop-stop.ts";

const ticket: Ticket = { path: "ticket.md", title: "挨拶", body: "Hello, name を返す" };
const remaining: Task[] = [{ id: "fix-a", title: "境界", dependsOn: [], instructions: "空白を拒否する" }];

function state(stopKind: StopKind, extra: Partial<LoopState> = {}): LoopState {
  return {
    ticket,
    assumptions: ["失敗は例外"],
    remaining,
    history: [{ attempt: 1, issues: remaining }],
    remainingTasks: remaining,
    ingestPosition: 1,
    completedTaskIds: ["feature"],
    integrationBranch: "harness/run/integration",
    integrationPath: "/tmp/integration",
    runId: "run",
    runDir: "/tmp/run",
    baseSha: "abc",
    baseBranch: "main",
    plan: { assumptions: [], tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }] },
    originalMaxLoops: 3,
    stopKind,
    ...extra,
  };
}

test("許可された再開入力だけを受け付ける", () => {
  assert.deepEqual(resumeActionFrom({ state: state("decreasing-fatal"), extraRounds: 2 }), { extraRounds: 2 });
  assert.deepEqual(resumeActionFrom({ state: state("stalled"), hint: "テストを先に直す" }), { hint: "テストを先に直す" });
  assert.deepEqual(resumeActionFrom({ state: state("stalled"), replanRemaining: true }), { replanRemaining: true });
  assert.deepEqual(resumeActionFrom({ state: state("insufficient-requirements"), answers: ["400 を返す"] }), {
    answers: ["400 を返す"],
  });
  assert.deepEqual(resumeActionFrom({ state: state("conflict"), continueFromIngest: true }), { continueFromIngest: true });
  assert.throws(() => resumeActionFrom({ state: state("stalled"), extraRounds: 1, hint: "x" }), /一手/);
  assert.throws(() => resumeActionFrom({ state: state("decreasing-fatal") }), /一手/);
  assert.throws(() => resumeActionFrom({ state: state("decreasing-fatal"), extraRounds: 0 }), /追加回数/);
});

test("停止種類に合わない再開入力は拒否する", () => {
  assert.throws(() => assertResumeAllowed("stalled", { extraRounds: 1 }), /追加回数/);
  assert.throws(() => assertResumeAllowed("decreasing-fatal", { hint: "x" }), /ヒント/);
  assert.throws(() => assertResumeAllowed("decreasing-fatal", { replanRemaining: true }), /再プラン/);
  assert.throws(() => assertResumeAllowed("decreasing-fatal", { answers: ["a"] }), /回答/);
  assert.throws(() => assertResumeAllowed("insufficient-requirements", { extraRounds: 1 }), /追加回数/);
  assert.throws(() => assertResumeAllowed("insufficient-requirements", { hint: "x" }), /ヒント/);
  assert.throws(() => assertResumeAllowed("changing", { answers: ["a"] }), /回答/);
  assert.throws(() => assertResumeAllowed("conflict", { extraRounds: 1 }), /追加回数/);
  assert.throws(() => assertResumeAllowed("conflict", { hint: "x" }), /ヒント/);
  assert.throws(() => assertResumeAllowed("conflict", { replanRemaining: true }), /再プラン/);
  assert.throws(() => assertResumeAllowed("branch-deviation", { answers: ["a"] }), /回答/);
  assert.throws(() => assertResumeAllowed("environment-check", { extraRounds: 2 }), /追加回数/);
  assert.doesNotThrow(() => assertResumeAllowed("changing", { extraRounds: 1 }));
  assert.doesNotThrow(() => assertResumeAllowed("changing", { hint: "x" }));
  assert.doesNotThrow(() => assertResumeAllowed("changing", { replanRemaining: true }));
  assert.doesNotThrow(() => assertResumeAllowed("environment-check", { continueFromIngest: true }));
});

test("回答は仮定へ足し、ヒントは残件へ足し、再プラン対象は残件だけにする", () => {
  const answered = applyAnswers(state("insufficient-requirements"), ["400 を返す"]);
  assert.deepEqual(answered.assumptions, ["失敗は例外", "400 を返す"]);
  const hinted = applyHint(state("stalled"), "既存テストを壊さない");
  assert.match(hinted.remaining[0]!.instructions, /既存テストを壊さない/);
  assert.equal(hinted.originalMaxLoops, 3);
  const completed = new Set(["feature"]);
  const pending = readyTasks(
    [
      { id: "feature", title: "機能", dependsOn: [], instructions: "機能" },
      { id: "next", title: "次", dependsOn: ["feature"], instructions: "次" },
    ],
    completed,
  );
  assert.deepEqual(
    pending.map((task) => ({ id: task.id, dependsOn: task.dependsOn })),
    [{ id: "next", dependsOn: [] }],
  );
});

test("再開状態を runDir に保存する", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-state-"));
  const value = state("decreasing-fatal", { runDir: dir, shouldPublishBase: true, baseBranch: dedicatedBaseBranch("run") });
  await saveLoopState(dir, value);
  const stored = JSON.parse(await readFile(path.join(dir, "loop-state.json"), "utf8")) as LoopState;
  assert.equal(stored.stopKind, "decreasing-fatal");
  assert.equal(stored.originalMaxLoops, 3);
  assert.equal(stored.integrationBranch, "harness/run/integration");
  assert.equal(stored.shouldPublishBase, true);
  const loaded = await loadLoopState(dir);
  assert.equal(loaded.runId, "run");
  assert.equal(loaded.shouldPublishBase, true);
  assert.equal((await loadLoopState(path.join(dir, "loop-state.json"))).stopKind, "decreasing-fatal");
});

test("専用ベースの公開要否は保存値を優先し、無ければベース情報から決める", () => {
  assert.equal(shouldPublishBaseFrom(state("decreasing-fatal", { shouldPublishBase: true })), true);
  assert.equal(shouldPublishBaseFrom(state("decreasing-fatal", { shouldPublishBase: false, baseBranch: dedicatedBaseBranch("run") })), false);
  const unnamed = state("decreasing-fatal", { baseBranch: dedicatedBaseBranch("run") });
  delete unnamed.shouldPublishBase;
  assert.equal(shouldPublishBaseFrom(unnamed), true);
  const main = state("decreasing-fatal", { baseBranch: "main" });
  delete main.shouldPublishBase;
  assert.equal(shouldPublishBaseFrom(main), false);
});
