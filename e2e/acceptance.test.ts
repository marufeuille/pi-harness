import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { allowedResumeActions, recommendationFor, type StopKind } from "../src/harness/loop-stop.ts";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const ticketText = "# Add greeting\n\nAdd hello.txt containing hello.\n";
const models = {
  smart: { provider: "openai-codex", id: "gpt-6-astra", parameters: { effort: "high" } },
  cheap: { provider: "cursor", id: "grok-4.6", parameters: { effort: "medium" } },
};
const phasesOff = { pullRequest: false, requireCi: false, merge: false, productionCheck: false };
const changingCheck =
  "sh -c 'i=0; [ -f .check-n ] && i=$(cat .check-n); i=$((i+1)); echo $i > .check-n; echo fail-$i; exit 1'";

test("harness rejects missing and repeated base revisions", async () => {
  for (const args of [["--base"], ["--base", "HEAD", "--base", "main"]]) {
    const result = await exec("npm", ["run", "harness", "--", "--ticket", "ticket.md", ...args], { cwd: root }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, stderr: error.stderr ?? "" }),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--base/);
  }
});

test("harness accepts clear and ambiguous tickets offline", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-e2e-"));
  try {
    const repo = await initRepo(temp);
    const ready = await runScenario(temp, repo, "clear", {}, ["--ticket"]);
    assert.equal(ready.code, 0, ready.stderr);
    const readyJson = resultJson(ready.stdout);
    assert.equal(readyJson.status, "ready");
    assert.ok(readyJson.integrationPath);
    assert.equal(await readFile(path.join(readyJson.integrationPath, "hello.txt"), "utf8"), "hello\\n");
    assert.equal((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout, "");

    const returned = await runScenario(temp, repo, "ambiguous", {}, ["--ticket"], { ticketText: "# Change it\n\nMake it better.\n" });
    assert.equal(returned.code, 0, returned.stderr);
    const outcome = resultJson(returned.stdout);
    assert.equal(outcome.status, "returned");
    assert.deepEqual(outcome.questions, ["何をどのように変更しますか？"]);
    assert.equal(outcome.integrationPath, undefined);
    assert.equal((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout, "");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resume CLI rejects contradictory or disallowed input before work starts", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-e2e-resume-cli-"));
  try {
    const repo = await initRepo(temp);
    const fixture = path.join(temp, "unused.json");
    await writeFile(fixture, JSON.stringify({ calls: [] }));
    const stateFile = path.join(temp, "loop-state.json");
    await writeFile(stateFile, JSON.stringify({
      ticket: { path: "t.md", title: "t", body: "b" },
      assumptions: [],
      remaining: [],
      history: [],
      remainingTasks: [],
      ingestPosition: 0,
      completedTaskIds: [],
      integrationBranch: "harness/run/integration",
      integrationPath: path.join(temp, "missing-integration"),
      runId: "run",
      runDir: temp,
      baseSha: "abc",
      baseBranch: "main",
      plan: { assumptions: [], tasks: [{ id: "T1", title: "t", dependsOn: [], instructions: "t" }] },
      originalMaxLoops: 3,
      stopKind: "stalled",
    }));

    const cases: Array<{ args: string[]; pattern: RegExp }> = [
      { args: ["--resume", stateFile, "--extra-rounds", "2", "--hint", "x"], pattern: /一手/ },
      { args: ["--resume", stateFile], pattern: /一手/ },
      { args: ["--extra-rounds", "1"], pattern: /--resume/ },
      { args: ["--resume", stateFile, "--ticket", "t.md", "--extra-rounds", "1"], pattern: /--resume と --ticket/ },
      { args: ["--resume", stateFile, "--base", "HEAD", "--extra-rounds", "1"], pattern: /起点/ },
      { args: ["--resume", stateFile, "--extra-rounds", "2"], pattern: /追加回数/ },
      { args: ["--resume", stateFile, "--answer", "400"], pattern: /回答/ },
    ];
    const linearState = path.join(temp, "linear-loop-state.json");
    await writeFile(linearState, JSON.stringify({
      ticket: { path: "linear:ABC-1", title: "t", body: "b" },
      assumptions: [],
      remaining: [],
      history: [],
      remainingTasks: [],
      ingestPosition: 0,
      completedTaskIds: [],
      integrationBranch: "harness/run/integration",
      integrationPath: path.join(temp, "missing-integration"),
      runId: "run",
      runDir: temp,
      baseSha: "abc",
      baseBranch: "main",
      plan: { assumptions: [], tasks: [{ id: "T1", title: "t", dependsOn: [], instructions: "t" }] },
      originalMaxLoops: 3,
      stopKind: "decreasing-fatal",
      linearIssueId: "ABC-1",
    }));
    cases.push({ args: ["--resume", linearState, "--linear", "XYZ-9", "--extra-rounds", "1"], pattern: /異なる/ });
    for (const item of cases) {
      const result = await spawnHarness(repo, fixture, item.args, { config: e2eConfig() });
      assert.notEqual(result.code, 0, item.args.join(" "));
      assert.match(result.stderr, item.pattern);
      assert.equal(result.stderr.includes("[harness]"), false);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("acceptance covers every stop kind, one recommendation, and resume from another process", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-e2e-resume-"));
  try {
    const repo = await initRepo(temp);
    const kinds: StopKind[] = [];

    const decreasing = await runScenario(temp, repo, "decreasing-fatal", { review: { maxLoops: 2 } }, ["--ticket"]);
    assert.equal(decreasing.code, 0, decreasing.stderr);
    const decreasingJson = resultJson(decreasing.stdout);
    assertStop(decreasingJson, "decreasing-fatal");
    kinds.push(decreasingJson.stop.kind);
    assert.equal(decreasingJson.resumeState.originalMaxLoops, 2);
    assert.match(decreasingJson.stop.lastOutput, /fix-a/);
    const extra = await runScenario(temp, repo, "decreasing-fatal", { review: { maxLoops: 2 } }, ["--resume", decreasingJson.runDir, "--extra-rounds", "1"], { phase: "resume" });
    assert.equal(extra.code, 0, extra.stderr);
    const extraJson = resultJson(extra.stdout);
    assert.equal(extraJson.status, "ready");
    assert.equal(extraJson.integrationPath, decreasingJson.integrationPath);
    assert.equal(extraJson.runId, decreasingJson.runId);
    assert.deepEqual(extraJson.assumptions, ["名前は必須"]);
    assert.equal(await readFile(path.join(extraJson.integrationPath, "hello.txt"), "utf8"), "hello\n");
    assert.equal(await readFile(path.join(extraJson.integrationPath, "a.txt"), "utf8"), "a-fixed\n");
    assert.equal(countIntegrationBranches(await git(repo, ["branch"])), 1);
    const cfg = { review: { maxLoops: 2 } };
    assert.equal(cfg.review.maxLoops, 2);

    const stalled = await runScenario(temp, repo, "stalled", { review: { maxLoops: 3 } }, ["--ticket"]);
    assert.equal(stalled.code, 0, stalled.stderr);
    const stalledJson = resultJson(stalled.stdout);
    assertStop(stalledJson, "stalled");
    kinds.push(stalledJson.stop.kind);
    assert.equal(stalledJson.stop.recommendation.includes("追加回数"), false);
    const rejectFixture = path.join(temp, "reject.json");
    await writeFile(rejectFixture, JSON.stringify({ calls: [] }));
    const rejected = await spawnHarness(repo, rejectFixture, ["--resume", stalledJson.runDir, "--extra-rounds", "2"], { config: e2eConfig({ review: { maxLoops: 3 } }) });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /追加回数/);
    assert.equal(rejected.stderr.includes("[harness]"), false);
    const hinted = await runScenario(temp, repo, "stalled", { review: { maxLoops: 3 } }, ["--resume", stalledJson.runDir, "--hint", "既存テストを壊さない"], { phase: "resume" });
    assert.equal(hinted.code, 0, hinted.stderr);
    assert.equal(resultJson(hinted.stdout).status, "ready");
    assert.equal(resultJson(hinted.stdout).integrationPath, stalledJson.integrationPath);

    const changing = await runScenario(temp, repo, "changing", { review: { maxLoops: 3 }, checks: [changingCheck] }, ["--ticket"]);
    assert.equal(changing.code, 0, changing.stderr);
    const changingJson = resultJson(changing.stdout);
    assertStop(changingJson, "changing");
    kinds.push(changingJson.stop.kind);
    assert.deepEqual(allowedResumeActions("changing"), ["extraRounds", "hint", "replanRemaining"]);
    const changingContinue = await runScenario(temp, repo, "changing", { review: { maxLoops: 3 }, checks: [changingCheck] }, ["--resume", changingJson.runDir, "--extra-rounds", "1"], { phase: "resume" });
    assert.equal(changingContinue.code, 0, changingContinue.stderr);
    assert.equal(resultJson(changingContinue.stdout).status, "ready");

    const questions = await runScenario(temp, repo, "insufficient", {}, ["--ticket"]);
    assert.equal(questions.code, 0, questions.stderr);
    const questionsJson = resultJson(questions.stdout);
    assert.equal(questionsJson.status, "returned");
    assert.equal(questionsJson.stop.kind, "insufficient-requirements");
    assertStop(questionsJson, "insufficient-requirements");
    kinds.push(questionsJson.stop.kind);
    assert.deepEqual(questionsJson.questions, ["失敗時の戻り値は何か"]);
    const answered = await runScenario(temp, repo, "insufficient", {}, ["--resume", questionsJson.runDir, "--answer", "400 を返す"], { phase: "resume" });
    assert.equal(answered.code, 0, answered.stderr);
    const answeredJson = resultJson(answered.stdout);
    assert.equal(answeredJson.status, "ready");
    assert.equal(answeredJson.integrationPath, questionsJson.integrationPath);
    assert.ok(answeredJson.assumptions.includes("400 を返す"));
    assert.ok(answeredJson.assumptions.includes("名前は必須"));

    const conflict = await runScenario(temp, repo, "conflict", {}, ["--ticket"]);
    assert.equal(conflict.code, 0, conflict.stderr);
    const conflictJson = resultJson(conflict.stdout);
    assertStop(conflictJson, "conflict");
    kinds.push(conflictJson.stop.kind);
    assert.deepEqual(conflictJson.stop.conflicts, ["shared.txt"]);
    const unresolved = await runScenario(temp, repo, "conflict", {}, ["--resume", conflictJson.runDir, "--continue-from-ingest"], { phase: "resume" });
    assert.equal(unresolved.code, 0, unresolved.stderr);
    const unresolvedJson = resultJson(unresolved.stdout);
    assert.equal(unresolvedJson.stop.kind, "conflict");
    assert.deepEqual(unresolvedJson.stop.conflicts, ["shared.txt"]);
    await writeFile(path.join(conflictJson.integrationPath, "shared.txt"), "resolved\n");
    await exec("git", ["-C", conflictJson.integrationPath, "add", "shared.txt"]);
    const resolved = await runScenario(temp, repo, "conflict", {}, ["--resume", conflictJson.runDir, "--continue-from-ingest"], { phase: "resume" });
    assert.equal(resolved.code, 0, resolved.stderr);
    const resolvedJson = resultJson(resolved.stdout);
    assert.equal(resolvedJson.status, "ready");
    assert.equal(resolvedJson.integrationPath, conflictJson.integrationPath);
    assert.equal(resolvedJson.runId, conflictJson.runId);
    assert.equal((await git(repo, ["branch"])).split("\n").filter((line) => line.includes(`${conflictJson.runId}/integration`)).length, 1);

    const drifted = await runScenario(temp, repo, "branch-deviation", {}, ["--ticket"]);
    assert.equal(drifted.code, 0, drifted.stderr);
    const driftedJson = resultJson(drifted.stdout);
    assertStop(driftedJson, "branch-deviation");
    kinds.push(driftedJson.stop.kind);
    const stillDrifted = await runScenario(temp, repo, "branch-deviation", {}, ["--resume", driftedJson.runDir, "--continue-from-ingest"], { phase: "resume" });
    assert.equal(resultJson(stillDrifted.stdout).stop.kind, "branch-deviation");
    await exec("git", ["-C", path.join(driftedJson.runDir, "tasks", "T1"), "checkout", `harness/${driftedJson.runId}/task/T1`]);
    const restored = await runScenario(temp, repo, "branch-deviation", {}, ["--resume", driftedJson.runDir, "--continue-from-ingest"], { phase: "resume" });
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(resultJson(restored.stdout).status, "ready");
    assert.equal(resultJson(restored.stdout).integrationPath, driftedJson.integrationPath);

    const missing = "definitely-not-a-harness-e2e-cmd";
    const envStop = await runScenario(temp, repo, "environment", { checks: [missing] }, ["--ticket"]);
    assert.equal(envStop.code, 0, envStop.stderr);
    const envJson = resultJson(envStop.stdout);
    assertStop(envJson, "environment-check");
    kinds.push(envJson.stop.kind);
    const envStill = await runScenario(temp, repo, "environment", { checks: [missing] }, ["--resume", envJson.runDir, "--continue-from-ingest"], { phase: "resume" });
    assert.equal(resultJson(envStill.stdout).stop.kind, "environment-check");
    const bin = path.join(temp, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, missing), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, missing), 0o755);
    const envFixed = await runScenario(temp, repo, "environment", { checks: [missing] }, ["--resume", envJson.runDir, "--continue-from-ingest"], {
      phase: "resume",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(envFixed.code, 0, envFixed.stderr);
    assert.equal(resultJson(envFixed.stdout).status, "ready");
    assert.equal(resultJson(envFixed.stdout).integrationPath, envJson.integrationPath);

    const concerns = await runScenario(temp, repo, "concerns", { review: { maxLoops: 1 } }, ["--ticket"]);
    assert.equal(concerns.code, 0, concerns.stderr);
    const concernsJson = resultJson(concerns.stdout);
    assert.equal(concernsJson.status, "ready");
    assert.deepEqual(concernsJson.concerns, ["ログの文言は後でよい"]);

    assert.deepEqual(new Set(kinds), new Set([
      "decreasing-fatal",
      "stalled",
      "changing",
      "insufficient-requirements",
      "conflict",
      "branch-deviation",
      "environment-check",
    ]));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function assertStop(result: { stop?: { kind: StopKind; recommendation: string; branch: string; worktree: string; lastOutput: string }; integrationPath?: string }, kind: StopKind): void {
  assert.ok(result.stop);
  assert.equal(result.stop.kind, kind);
  assert.equal(result.stop.recommendation, recommendationFor(kind));
  assert.equal(typeof result.stop.recommendation, "string");
  assert.ok(result.stop.recommendation.length > 0);
  assert.equal(result.stop.recommendation.includes("\n"), false);
  assert.ok(result.stop.branch);
  assert.equal(result.stop.worktree, result.integrationPath);
  assert.ok(result.stop.lastOutput.length > 0);
}

function resultJson(stdout: string): any {
  return JSON.parse(stdout.slice(stdout.lastIndexOf("\n{") + 1));
}

function e2eConfig(overrides: { review?: { maxLoops: number }; checks?: string[] } = {}): object {
  return {
    models,
    phases: phasesOff,
    review: overrides.review ?? { maxLoops: 3 },
    checks: overrides.checks ?? [],
  };
}

function countIntegrationBranches(listed: string): number {
  return [...listed.matchAll(/integration/g)].length;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initRepo(temp: string): Promise<string> {
  const repo = path.join(temp, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "README.md"), "seed\n");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "add", "."]);
  await exec("git", ["-C", repo, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-m", "initial"]);
  const remote = path.join(repo, ".git", "origin.git");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["-C", repo, "remote", "add", "origin", remote]);
  await exec("git", ["-C", repo, "push", "-u", "origin", "main"]);
  return repo;
}

async function runScenario(
  temp: string,
  repo: string,
  name: string,
  configOverrides: { review?: { maxLoops: number }; checks?: string[] },
  argsPrefix: string[],
  options: { phase?: "first" | "resume"; ticketText?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scenario = JSON.parse(await readFile(path.join(root, "fixtures/resume", `${name}.json`), "utf8")) as {
    first: { calls: unknown[] };
    resume?: { calls: unknown[] };
  };
  const phase = options.phase ?? "first";
  const calls = phase === "resume" ? scenario.resume?.calls : scenario.first.calls;
  if (!calls) throw new Error(`${name} に ${phase} フィクスチャがありません`);
  const fixture = path.join(temp, `${name}-${phase}.json`);
  const config = path.join(temp, `${name}-${phase}-config.json`);
  await writeFile(fixture, JSON.stringify({ calls }));
  await writeFile(config, JSON.stringify(e2eConfig(configOverrides)));
  const args = argsPrefix[0] === "--ticket"
    ? ["--ticket", await writeTicket(temp, name, options.ticketText ?? ticketText), "--repo", repo, "--config", config]
    : [...argsPrefix, "--repo", repo, "--config", config];
  return spawnHarness(repo, fixture, args, { config: undefined, env: options.env });
}

async function writeTicket(temp: string, name: string, text: string): Promise<string> {
  const ticket = path.join(temp, `${name}.md`);
  await writeFile(ticket, text);
  return ticket;
}

async function spawnHarness(
  repo: string,
  fixture: string,
  args: string[],
  options: { config?: object; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let configArg: string[] = [];
  if (options.config) {
    const configPath = path.join(path.dirname(fixture), `spawn-config-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(configPath, JSON.stringify(options.config));
    configArg = ["--config", configPath];
  }
  return await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "harness", "--", ...args, ...configArg], {
      cwd: root,
      env: {
        ...process.env,
        ...options.env,
        HARNESS_E2E_FIXTURE: path.resolve(fixture),
        API_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        CURSOR_API_KEY: "",
        LINEAR_API_KEY: "",
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
