import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runMain } from "./main.ts";
import type { LoopState } from "./loop-state.ts";
import type { WorkflowResult } from "./workflow.ts";

const ready: WorkflowResult = {
  status: "ready",
  assumptions: [],
  concerns: [],
  jsonReadFailures: [],
  runId: "run",
  runDir: "/tmp/run",
};

function loopState(extra: Partial<LoopState> = {}): LoopState {
  return {
    ticket: { path: "linear:ABC-1", title: "t", body: "b" },
    assumptions: [],
    remaining: [],
    history: [],
    remainingTasks: [],
    ingestPosition: 0,
    completedTaskIds: [],
    integrationBranch: "harness/run/integration",
    integrationPath: "/tmp/integration",
    runId: "run",
    runDir: "/tmp/run",
    baseSha: "abc",
    baseBranch: "main",
    plan: { assumptions: [], tasks: [{ id: "T1", title: "t", dependsOn: [], instructions: "t" }] },
    originalMaxLoops: 3,
    stopKind: "decreasing-fatal",
    linearIssueId: "ABC-1",
    ...extra,
  };
}

async function writeState(state: LoopState): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "linear-resume-"));
  await writeFile(path.join(dir, "loop-state.json"), JSON.stringify(state));
  return dir;
}

async function writeConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "linear-resume-config-"));
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify({
    models: {
      smart: { provider: "openai-codex", id: "gpt-6-astra", parameters: { effort: "high" } },
      cheap: { provider: "openai-codex", id: "gpt-6-luna", parameters: { effort: "medium" } },
    },
    phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false },
    review: { maxLoops: 3 },
    checks: [],
  }));
  return file;
}

async function captureIo<T>(fn: (io: { stdout: { write(chunk: string): void }; stderr: { write(chunk: string): void } }) => Promise<T>): Promise<{ value: T; stderr: string }> {
  let stderr = "";
  const io = {
    stdout: { write(_chunk: string) {} },
    stderr: { write(chunk: string) { stderr += chunk; } },
  };
  return { value: await fn(io), stderr };
}

test("--linear 再指定なしの再開は開始状態を書き直さず、成功時だけ元課題を Done にする", async () => {
  const dir = await writeState(loopState());
  const config = await writeConfig();
  const calls: Array<[string, string]> = [];
  let started = false;
  const { value: code, stderr } = await captureIo((io) => runMain([
    "node", "main.ts",
    "--resume", dir,
    "--extra-rounds", "1",
    "--config", config,
    "--repo", dir,
  ], {
    ...io,
    updateLinearIssueState: async (id, state) => {
      calls.push([id, state]);
      return { ok: true };
    },
    runWorkflow: async (input) => {
      started = true;
      assert.equal(input.linearIssueId, "ABC-1");
      assert.equal(input.resume?.state.linearIssueId, "ABC-1");
      return ready;
    },
  }));
  assert.equal(code, 0);
  assert.equal(started, true);
  assert.deepEqual(calls, [["ABC-1", "Done"]]);
  assert.equal(stderr.includes("[harness]"), false);
});

test("再開時の異なる Linear 課題指定は作業開始前に拒否する", async () => {
  const dir = await writeState(loopState());
  const calls: Array<[string, string]> = [];
  let started = false;
  const { value: code, stderr } = await captureIo((io) => runMain([
    "node", "main.ts",
    "--resume", dir,
    "--linear", "XYZ-9",
    "--extra-rounds", "1",
  ], {
    ...io,
    updateLinearIssueState: async (id, state) => {
      calls.push([id, state]);
      return { ok: true };
    },
    runWorkflow: async () => {
      started = true;
      return ready;
    },
  }));
  assert.equal(code, 1);
  assert.equal(started, false);
  assert.deepEqual(calls, []);
  assert.match(stderr, /異なる/);
  assert.equal(stderr.includes("[harness]"), false);
});

test("同じ課題の URL 指定は再開を許可し、元課題だけを Done にする", async () => {
  const dir = await writeState(loopState());
  const config = await writeConfig();
  const calls: Array<[string, string]> = [];
  const { value: code } = await captureIo((io) => runMain([
    "node", "main.ts",
    "--resume", dir,
    "--linear", "https://linear.app/acme/issue/ABC-1/example",
    "--extra-rounds", "1",
    "--config", config,
    "--repo", dir,
  ], {
    ...io,
    updateLinearIssueState: async (id, state) => {
      calls.push([id, state]);
      return { ok: true };
    },
    runWorkflow: async () => ready,
  }));
  assert.equal(code, 0);
  assert.deepEqual(calls, [["ABC-1", "Done"]]);
});

test("保存フィールドがなくても ticket.path から元課題を復元して Done にする", async () => {
  const dir = await writeState(loopState({ linearIssueId: undefined }));
  const config = await writeConfig();
  const calls: Array<[string, string]> = [];
  const { value: code } = await captureIo((io) => runMain([
    "node", "main.ts",
    "--resume", dir,
    "--extra-rounds", "1",
    "--config", config,
    "--repo", dir,
  ], {
    ...io,
    updateLinearIssueState: async (id, state) => {
      calls.push([id, state]);
      return { ok: true };
    },
    runWorkflow: async (input) => {
      assert.equal(input.linearIssueId, "ABC-1");
      return ready;
    },
  }));
  assert.equal(code, 0);
  assert.deepEqual(calls, [["ABC-1", "Done"]]);
});

test("Markdown 実行の再開に --linear を足すと作業開始前に拒否する", async () => {
  const dir = await writeState(loopState({
    linearIssueId: undefined,
    ticket: { path: "ticket.md", title: "t", body: "b" },
  }));
  const calls: Array<[string, string]> = [];
  let started = false;
  const { value: code, stderr } = await captureIo((io) => runMain([
    "node", "main.ts",
    "--resume", dir,
    "--linear", "ABC-1",
    "--extra-rounds", "1",
  ], {
    ...io,
    updateLinearIssueState: async (id, state) => {
      calls.push([id, state]);
      return { ok: true };
    },
    runWorkflow: async () => {
      started = true;
      return ready;
    },
  }));
  assert.equal(code, 1);
  assert.equal(started, false);
  assert.deepEqual(calls, []);
  assert.match(stderr, /異なる/);
});

test("Markdown 実行の再開では Linear 状態を更新しない", async () => {
  const dir = await writeState(loopState({
    linearIssueId: undefined,
    ticket: { path: "ticket.md", title: "t", body: "b" },
  }));
  const config = await writeConfig();
  const calls: Array<[string, string]> = [];
  const { value: code } = await captureIo((io) => runMain([
    "node", "main.ts",
    "--resume", dir,
    "--extra-rounds", "1",
    "--config", config,
    "--repo", dir,
  ], {
    ...io,
    updateLinearIssueState: async (id, state) => {
      calls.push([id, state]);
      return { ok: true };
    },
    runWorkflow: async (input) => {
      assert.equal(input.linearIssueId, undefined);
      return ready;
    },
  }));
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
});
