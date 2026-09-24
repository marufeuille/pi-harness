import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

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
    const run = async (name: string, ticketText: string, calls: unknown[]) => {
      const ticket = path.join(temp, `${name}.md`);
      const fixture = path.join(temp, `${name}.json`);
      const config = path.join(temp, `${name}-config.json`);
      await writeFile(ticket, ticketText);
      await writeFile(fixture, JSON.stringify({ calls }));
      await writeFile(config, JSON.stringify({ models: { smart: "astra", cheap: "grok" }, phases: { pullRequest: false, requireCi: false, merge: false, productionCheck: false }, review: { maxLoops: 3 }, checks: [] }));
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("npm", ["run", "harness", "--", "--ticket", ticket, "--repo", repo, "--config", config], {
        cwd: root, env: { ...process.env, HARNESS_E2E_FIXTURE: path.resolve(fixture), API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", CURSOR_API_KEY: "", LINEAR_API_KEY: "", GH_TOKEN: "", GITHUB_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
      child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    };
    const result = await run("clear", "# Add greeting\n\nAdd hello.txt containing hello.\n", [
      { stage: "clarify", text: '{"decision":"proceed","assumptions":[]}' },
      { stage: "plan", text: '{"assumptions":[],"tasks":[{"id":"T1","title":"Add greeting","instructions":"Add hello.txt containing hello","dependsOn":[]}]}' },
      { stage: "implement", text: "", writes: [{ path: "hello.txt", content: "hello\\n" }] },
      { stage: "review", text: '{"decision":"pass","concerns":[]}' },
    ]);
    assert.equal(result.code, 0, result.stderr);
    const resultJson = (stdout: string) => JSON.parse(stdout.slice(stdout.lastIndexOf("\n{") + 1));
    const ready = resultJson(result.stdout);
    assert.equal(ready.status, "ready");
    assert.ok(ready.integrationPath);
    assert.equal(await readFile(path.join(ready.integrationPath, "hello.txt"), "utf8"), "hello\\n");
    assert.equal((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout, "");

    const returned = await run("ambiguous", "# Change it\n\nMake it better.\n", [
      { stage: "clarify", text: '{"decision":"return","questions":["何をどのように変更しますか？"]}' },
    ]);
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
